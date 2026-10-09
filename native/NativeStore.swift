import Foundation
import CryptoKit
import SQLite3

enum StoreFailure: Error, Equatable { case invalid, unavailable, database, integrity, space }
extension StoreFailure {
    static func isSpace(_ error: Error) -> Bool {
        if (error as? StoreFailure) == .space { return true }
        var value = error as NSError
        for _ in 0..<5 {
            if value.domain == NSPOSIXErrorDomain && [28,69].contains(value.code) { return true }
            if value.domain == NSCocoaErrorDomain && value.code == CocoaError.Code.fileWriteOutOfSpace.rawValue { return true }
            guard let nested = value.userInfo[NSUnderlyingErrorKey] as? NSError else { break }; value = nested
        }
        return false
    }
}

// Native and Safari profiles remain isolated. Paths come only from hashed IDs;
// the browser never gets to select a filesystem path.
final class NativeStore {
    let root: URL
    let cacheRoot: URL
    private var db: OpaquePointer?
    private let fm = FileManager.default
    private let tables = Set(["accounts", "images", "views", "jobs", "hidden", "assetInfo", "settings", "migration", "demands", "conversations"])
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func hash(_ text: String) -> String { hash(Data(text.utf8)) }
    convenience init(group: String, profile: String, probe: Bool = false) throws {
        let fm = FileManager.default
        let base: URL
        if group == "legacy-export" {
            base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("ImagesManagerLegacy")
        } else {
            guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw StoreFailure.unavailable }
            base = container.appendingPathComponent("Library/Application Support/ImagesManager")
        }
        let directory = base.appendingPathComponent(probe ? "probes" : "profiles").appendingPathComponent(Self.hash(profile))
        try self.init(persistentRoot: directory)
        if group == "legacy-export" {
            try JSONSerialization.data(withJSONObject: ["schema":1,"profile":profile]).write(to: root.appendingPathComponent("profile.json"), options:.atomic)
        }
    }
    init(persistentRoot: URL, cacheRoot: URL? = nil) throws {
        root = persistentRoot
        self.cacheRoot = cacheRoot ?? fm.urls(for:.cachesDirectory,in:.userDomainMask)[0].appendingPathComponent("ImagesManagerThumbnails").appendingPathComponent(Self.hash(persistentRoot.path))
        try fm.createDirectory(at: root.appendingPathComponent("originals"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("staging"), withIntermediateDirectories: true)
        guard sqlite3_open_v2(root.appendingPathComponent("index.sqlite").path, &db,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw StoreFailure.database }
        sqlite3_busy_timeout(db, 10000)
        try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(store,key));")
    }
    init(exportRoot: URL) throws {
        root = exportRoot
        cacheRoot = exportRoot.appendingPathComponent("unused-readonly-cache")
        guard sqlite3_open_v2(root.appendingPathComponent("index.sqlite").path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw StoreFailure.database }
        sqlite3_busy_timeout(db,10000)
    }
    deinit { sqlite3_close(db) }
    private func exec(_ sql: String) throws {
        let result = sqlite3_exec(db, sql, nil, nil, nil)
        guard result == SQLITE_OK else { throw result == SQLITE_FULL ? StoreFailure.space : StoreFailure.database }
    }
    private func statement(_ sql: String, _ args: [String]) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw StoreFailure.database }
        for (n, arg) in args.enumerated() {
            sqlite3_bind_text(stmt, Int32(n + 1), arg, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
        return stmt
    }
    private func check(_ store: String) throws { guard tables.contains(store) else { throw StoreFailure.invalid } }
    func get(_ store: String, _ key: String) throws -> [String: Any]? {
        try check(store)
        let stmt = try statement("SELECT json FROM records WHERE store=? AND key=?", [store, key]); defer { sqlite3_finalize(stmt) }
        let status = sqlite3_step(stmt)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let text = sqlite3_column_text(stmt, 0) else { throw StoreFailure.database }
        return try JSONSerialization.jsonObject(with: Data(String(cString: text).utf8)) as? [String: Any]
    }
    func all(_ store: String) throws -> [[String: Any]] {
        try check(store)
        let stmt = try statement("SELECT json FROM records WHERE store=? ORDER BY key", [store]); defer { sqlite3_finalize(stmt) }
        var values = [[String: Any]]()
        var status = sqlite3_step(stmt)
        while status == SQLITE_ROW {
            guard let text = sqlite3_column_text(stmt, 0), let row = try JSONSerialization.jsonObject(with: Data(String(cString: text).utf8)) as? [String: Any] else { throw StoreFailure.database }
            values.append(row)
            status = sqlite3_step(stmt)
        }
        guard status == SQLITE_DONE else { throw StoreFailure.database }
        return values
    }
    func put(_ store: String, _ value: [String: Any]) throws {
        try check(store)
        guard let key = value["key"] as? String, !key.isEmpty, key.count < 4096,
              JSONSerialization.isValidJSONObject(value) else { throw StoreFailure.invalid }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
        let stmt = try statement("INSERT INTO records(store,key,json) VALUES(?,?,?) ON CONFLICT(store,key) DO UPDATE SET json=excluded.json", [store,key,json])
        defer { sqlite3_finalize(stmt) }
        let result = sqlite3_step(stmt)
        guard result == SQLITE_DONE else { throw result == SQLITE_FULL ? StoreFailure.space : StoreFailure.database }
    }
    func transaction<T>(_ block: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE")
        do { let result = try block(); try exec("COMMIT"); return result }
        catch { try? exec("ROLLBACK"); throw error }
    }
    private func path(_ key: String, _ digest: String) -> URL { root.appendingPathComponent("originals").appendingPathComponent(Self.hash(key + ":" + digest)) }
    private func staging(_ token: String) throws -> URL {
        guard UUID(uuidString: token) != nil else { throw StoreFailure.invalid }
        return root.appendingPathComponent("staging").appendingPathComponent(token)
    }
    func handle(_ request: [String: Any]) throws -> Any {
        guard let op = request["op"] as? String else { throw StoreFailure.invalid }
        let store = request["store"] as? String ?? "", key = request["key"] as? String ?? ""
        switch op {
        case "thumbnail-info": return try thumbnailInfo(request)
        case "thumbnail-read": return try thumbnailRead(request)
        case "export-location": return root.deletingLastPathComponent().path
        case "export-profile": return root.lastPathComponent
        case "verify-page", "migration-receipt-page":
            if op == "migration-receipt-page", try get("migration","legacy-import")?["phase"] as? String != "verified" { throw StoreFailure.integrity }
            let after = request["after"] as? String ?? ""
            let stmt = try statement("SELECT json FROM records WHERE store='assetInfo' AND json_extract(json,'$.kind')='original' AND key>? ORDER BY key LIMIT 16",[after])
            defer { sqlite3_finalize(stmt) }
            var originals = [[String:Any]](), status = sqlite3_step(stmt), last = after
            while status == SQLITE_ROW {
                guard let text = sqlite3_column_text(stmt,0), let info = try JSONSerialization.jsonObject(with:Data(String(cString:text).utf8)) as? [String:Any],
                    let key = info["key"] as? String, let size = info["size"] as? Int, let digest = info["digest"] as? String else { throw StoreFailure.integrity }
                let bytes = try Data(contentsOf:path(key,digest),options:.mappedIfSafe)
                guard bytes.count == size, Self.hash(bytes) == digest else { throw StoreFailure.integrity }
                originals.append(["key":key,"digest":digest,"size":size]); last = key; status = sqlite3_step(stmt)
            }
            guard status == SQLITE_DONE else { throw StoreFailure.database }
            return ["schema":1,"profileHash":root.lastPathComponent,"verified":originals.count,
                "originals":op == "migration-receipt-page" ? originals : [], "after":originals.count == 16 ? last as Any : NSNull()]
        case "ping":
            let proof = root.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("validation")
            try fm.createDirectory(at:proof,withIntermediateDirectories:true)
            try Data("{\"native\":true}".utf8).write(to:proof.appendingPathComponent("native.json"),options:.atomic)
            let app = (try? Data(contentsOf:proof.appendingPathComponent("app.json"))).flatMap { try? JSONSerialization.jsonObject(with:$0) as? [String:Any] }
            return ["schema": 1, "persistent": true, "appProof":app ?? [:]]
        case "get": if let value = try get(store,key) { return value }; return NSNull()
        case "chat-states":
            guard let account = request["account"] as? String, !account.isEmpty,
                let rows = request["rows"] as? [[String:Any]], !rows.isEmpty, rows.count <= 10,
                rows.allSatisfy({ row in
                    guard let id = row["id"] as? String, id.range(of:"^[\\w-]{1,128}$",options:.regularExpression) != nil,
                        row["archived"] is Bool, let checked = row["checkedAt"] as? Double, checked.isFinite, checked > 0 else { return false }
                    return true
                }) else { throw StoreFailure.invalid }
            return try transaction { () -> [[String:Any]] in
                var saved = [[String:Any]](), archived = Set<String>()
                for row in rows {
                    let id = row["id"] as! String, key = account + ":" + id, previous = try get("conversations",key)
                    var value = row
                    if (previous?["checkedAt"] as? Double ?? 0) > (row["checkedAt"] as! Double) { value = previous! }
                    value["account"] = account; value["key"] = key
                    try put("conversations",value); saved.append(value)
                    if value["archived"] as? Bool == true { archived.insert(id) }
                }
                if !archived.isEmpty {
                    for var image in try all("images") where image["account"] as? String == account && image["deleted"] as? Bool == true {
                        if archived.contains(image["conversationId"] as? String ?? "") { image["deleted"] = false; try put("images",image) }
                    }
                }
                return saved
            }
        case "summary":
            guard let account = request["account"] as? String else { throw StoreFailure.invalid }
            let images = try all("images").filter { $0["account"] as? String == account }
            let assets = try all("assetInfo").filter { $0["account"] as? String == account && $0["kind"] as? String == "original" }
            let keys = Set(assets.compactMap { $0["key"] as? String })
            var total = 0, completed = 0, retained = 0, favorites = 0, cache = 0
            for image in images {
                guard let id = image["id"] as? String else { continue }
                let saved = keys.contains("\(account):\(id):original")
                if image["deleted"] as? Bool == true { if saved { retained += 1 } }
                else { total += 1; if saved { completed += 1 } }
            }
            for asset in assets {
                let size = asset["size"] as? Int ?? 0
                if asset["pinned"] as? Bool == true { favorites += size } else { cache += size }
            }
            return ["total":total,"completed":completed,"retained":retained,"favorites":favorites,"cache":cache]
        case "all": return try all(store)
        case "list":
            try check(store)
            guard let offset = request["offset"] as? Int, offset >= 0 else { throw StoreFailure.invalid }
            let stmt = try statement("SELECT json FROM records WHERE store=? ORDER BY key LIMIT 100 OFFSET ?", [store,String(offset)])
            defer { sqlite3_finalize(stmt) }
            var rows = [[String:Any]](); var status = sqlite3_step(stmt)
            while status == SQLITE_ROW {
                guard let text = sqlite3_column_text(stmt,0), let row = try JSONSerialization.jsonObject(with:Data(String(cString:text).utf8)) as? [String:Any] else { throw StoreFailure.database }
                rows.append(row); status = sqlite3_step(stmt)
            }
            guard status == SQLITE_DONE else { throw StoreFailure.database }; return rows
        case "put":
            guard let value = request["value"] as? [String: Any] else { throw StoreFailure.invalid }
            try put(store, value); return true
        case "batch":
            guard let rows = request["rows"] as? [[String: Any]], rows.count <= 250 else { throw StoreFailure.invalid }
            try transaction { for value in rows { try put(store, value) } }; return true
        case "import-missing":
            guard let rows = request["rows"] as? [[String: Any]], rows.count <= 100 else { throw StoreFailure.invalid }
            try transaction {
                for value in rows {
                    guard let id = value["key"] as? String else { throw StoreFailure.invalid }
                    if try get(store,id) == nil { try put(store,value) }
                }
            }; return true
        case "update":
            guard let changes = request["changes"] as? [String: Any] else { throw StoreFailure.invalid }
            return try transaction { () -> [String: Any] in
                var row = try get(store,key) ?? [:]; row.merge(changes) { _,new in new }; row["key"] = key
                try put(store,row); return row
            }
        case "hidden":
            guard let account = request["account"] as? String, let id = request["id"] as? String else { throw StoreFailure.invalid }
            return try transaction { () -> [String: Any] in
                var ids = Set(try get("hidden", account)?["ids"] as? [String] ?? [])
                if request["hidden"] as? Bool == true { ids.insert(id) } else { ids.remove(id) }
                try put("hidden", ["key": account, "ids": Array(ids).sorted()]); return ["id":id,"hidden":ids.contains(id)]
            }
        case "favorite":
            guard let account = request["account"] as? String, let id = request["id"] as? String else { throw StoreFailure.invalid }
            return try transaction { () -> [String: Any] in
                guard var image = try get("images", "\(account):\(id)") else { throw StoreFailure.invalid }
                let favorite = request["favorite"] as? Bool == true
                image["favorite"] = favorite
                let assetKey = "\(account):\(id):original"
                var asset = try get("assetInfo", assetKey)
                image["localOriginal"] = asset != nil
                image["saved"] = favorite && asset != nil
                if asset != nil { asset!["pinned"] = favorite; try put("assetInfo",asset!) }
                try put("images",image); return image
            }
        case "bulk-flags":
            guard let account = request["account"] as? String, !account.isEmpty,
                  let incoming = request["ids"] as? [String], !incoming.isEmpty, incoming.count <= 100,
                  incoming.allSatisfy({ !$0.isEmpty && $0.count <= 1024 }),
                  let kind = request["kind"] as? String, ["hidden", "favorite"].contains(kind),
                  let value = request["value"] as? Bool else { throw StoreFailure.invalid }
            let ids = incoming.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            return try transaction { () -> [String: Any] in
                var succeeded = [String](), failed = [[String: String]](), images = [[String: Any]]()
                var hidden = Set(try get("hidden", account)?["ids"] as? [String] ?? [])
                for id in ids {
                    guard var image = try get("images", "\(account):\(id)") else {
                        failed.append(["id": id, "error": "图片不存在"]); continue
                    }
                    if kind == "hidden" {
                        if value { hidden.insert(id) } else { hidden.remove(id) }
                    } else {
                        let key = "\(account):\(id):original"
                        var asset = try get("assetInfo", key)
                        image["favorite"] = value; image["localOriginal"] = asset != nil
                        image["saved"] = value && asset != nil
                        if asset != nil { asset!["pinned"] = value; try put("assetInfo", asset!) }
                        try put("images", image); images.append(image)
                    }
                    succeeded.append(id)
                }
                if kind == "hidden" && !succeeded.isEmpty { try put("hidden", ["key": account, "ids": Array(hidden).sorted()]) }
                return ["succeeded": succeeded, "failed": failed, "images": images]
            }
        case "merge":
            guard let account = request["account"] as? String, let incoming = request["images"] as? [[String: Any]] else { throw StoreFailure.invalid }
            return try transaction { () -> [[String: Any]] in
                var seen = Set<String>()
                for value in incoming {
                    guard let id = value["id"] as? String else { throw StoreFailure.invalid }; seen.insert(id)
                    let previous = try get("images","\(account):\(id)") ?? [:]; var image = previous
                    image.merge(value) { _,new in new }; image["favorite"] = previous["favorite"] ?? false
                    image["saved"] = previous["saved"] ?? false; image["deleted"] = false
                    for dimension in ["width", "height"] where (value[dimension] as? Double ?? 0) <= 0 {
                        image[dimension] = previous[dimension]
                    }
                    image["key"] = "\(account):\(id)"; image["account"] = account
                    try put("images",image)
                }
                if request["complete"] as? Bool == true {
                    for var image in try all("images") where image["account"] as? String == account {
                        if let id = image["id"] as? String, !seen.contains(id) {
                            let chat = image["conversationId"] as? String ?? ""
                            image["deleted"] = try get("conversations", "\(account):\(chat)")?["archived"] as? Bool != true
                            try put("images",image)
                        }
                    }
                }
                return []
            }
        case "reconcile":
            guard let account = request["account"] as? String, let ids = request["ids"] as? [String] else { throw StoreFailure.invalid }
            let seen = Set(ids)
            try transaction {
                for var image in try all("images") where image["account"] as? String == account {
                    guard let id = image["id"] as? String else { throw StoreFailure.invalid }
                    if !seen.contains(id) {
                        let chat = image["conversationId"] as? String ?? ""
                        image["deleted"] = try get("conversations", "\(account):\(chat)")?["archived"] as? Bool != true
                        try put("images",image)
                    }
                }
            }; return true
        case "asset-info": if let value = try get("assetInfo",key) { return value }; return NSNull()
        case "asset-read":
            guard let info = try get("assetInfo",key), let size = info["size"] as? Int,
                let offset = request["offset"] as? Int, offset >= 0, offset <= size else { return NSNull() }
            let length = request["length"] as? Int ?? 262144
            guard length > 0, length <= 4194304 else { throw StoreFailure.invalid }
            let file = try FileHandle(forReadingFrom: path(key, info["digest"] as? String ?? "")); defer { try? file.close() }
            try file.seek(toOffset: UInt64(offset)); let data = try file.read(upToCount: length) ?? Data()
            return ["data": data.base64EncodedString(), "offset":offset, "size":size, "mime":info["mime"] ?? "", "digest":info["digest"] ?? ""]
        case "asset-begin":
            guard let size = request["size"] as? Int, size >= 0, size <= 268435456 else { throw StoreFailure.invalid }
            let available = try root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
            guard available > Int64(size) + 67108864 else { throw StoreFailure.space }
            let token = UUID().uuidString; try Data().write(to:staging(token)); return ["token":token]
        case "asset-chunk":
            guard let token = request["token"] as? String, let encoded = request["data"] as? String,
                encoded.count <= 349528, let data = Data(base64Encoded: encoded), let offset = request["offset"] as? Int, offset >= 0, offset + data.count <= 268435456 else { throw StoreFailure.invalid }
            let url = try staging(token), file = try FileHandle(forWritingTo: url); defer { try? file.close() }
            let end = try file.seekToEnd()
            if end > UInt64(offset) {
                let reader = try FileHandle(forReadingFrom:url); defer { try? reader.close() }
                try reader.seek(toOffset:UInt64(offset))
                guard try reader.read(upToCount:data.count) == data else { throw StoreFailure.integrity }; return true
            }
            guard end == UInt64(offset) else { throw StoreFailure.integrity }; try file.write(contentsOf: data); return true
        case "asset-abort":
            guard let token = request["token"] as? String else { throw StoreFailure.invalid }
            let url = try staging(token)
            if fm.fileExists(atPath:url.path) { try fm.removeItem(at:url) }; return true
        case "asset-commit":
            guard let token = request["token"] as? String, var info = request["info"] as? [String: Any],
                let key = info["key"] as? String, let account = info["account"] as? String,
                let id = info["id"] as? String, info["kind"] as? String == "original",
                key == "\(account):\(id):original", let size = info["size"] as? Int,
                let digest = request["digest"] as? String else { throw StoreFailure.invalid }
            let url = try staging(token)
            if !fm.fileExists(atPath:url.path), let committed = try get("assetInfo",key),
                committed["digest"] as? String == digest, committed["size"] as? Int == size {
                let saved = try Data(contentsOf:path(key,digest),options:.mappedIfSafe)
                guard saved.count == size, Self.hash(saved) == digest else { throw StoreFailure.integrity }
                return committed
            }
            let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
            guard bytes.count == size, Self.hash(bytes) == digest else { throw StoreFailure.integrity }
            let file = try FileHandle(forWritingTo: url); try file.synchronize(); try file.close()
            info["digest"] = digest
            return try transaction { () -> [String: Any] in
                let destination = path(key,digest)
                if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: url) }
                else { try fm.moveItem(at: url, to: destination) }
                if var image = try get("images", "\(account):\(id)") {
                    info["pinned"] = image["favorite"] as? Bool == true
                    image["localOriginal"] = true; image["saved"] = image["favorite"] as? Bool == true
                    try put("images",image)
                }
                try put("assetInfo",info)
                return info
            }
        case "verify-assets":
            let assets = try all("assetInfo"); var count = 0
            for info in assets where (info["kind"] as? String) == "original" {
                guard let key = info["key"] as? String, let size = info["size"] as? Int,
                    let digest = info["digest"] as? String else { throw StoreFailure.integrity }
                let bytes = try Data(contentsOf:path(key,digest),options:.mappedIfSafe)
                guard bytes.count == size, Self.hash(bytes) == digest else { throw StoreFailure.integrity }; count += 1
            }
            return ["verified":count]
        default: throw StoreFailure.invalid
        }
    }
}
