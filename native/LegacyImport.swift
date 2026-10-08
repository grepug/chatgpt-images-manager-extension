import Foundation

extension NativeStore {
    // The source is an explicit user-selected export directory, never Safari's
    // internal database. Copy and verify each original before marking completion.
    static func importLegacy(_ directory: URL, group: String) throws -> Int {
        try importLegacy(directory) { try NativeStore(group:group,profile:$0) }
    }
    static func importLegacy(_ directory: URL, destinationForProfile: (String) throws -> NativeStore) throws -> Int {
        let fm = FileManager.default
        let folders = try fm.contentsOfDirectory(at:directory,includingPropertiesForKeys:[.isDirectoryKey])
            .filter { (try? $0.resourceValues(forKeys:[.isDirectoryKey]).isDirectory) == true }
        var total = 0
        for folder in folders {
            guard let manifest = try JSONSerialization.jsonObject(with:Data(contentsOf:folder.appendingPathComponent("profile.json"))) as? [String:Any],
                manifest["schema"] as? Int == 1, let profile = manifest["profile"] as? String,
                folder.lastPathComponent == hash(profile) else { throw StoreFailure.integrity }
            let source = try NativeStore(exportRoot:folder), destination = try destinationForProfile(profile)
            guard try source.get("migration","legacy-export")?["phase"] as? String == "verified" else { throw StoreFailure.integrity }
            let assets = try source.all("assetInfo").filter { $0["kind"] as? String == "original" }
            try destination.put("migration",["key":"legacy-import","phase":"copying","completed":0,"total":assets.count])
            var completed = 0
            do {
            for store in ["accounts","images","views","hidden"] {
                try destination.transaction {
                    for var row in try source.all(store) {
                        guard let key = row["key"] as? String else { throw StoreFailure.invalid }
                        if let existing = try destination.get(store,key) {
                            if store == "hidden" {
                                row["ids"] = Array(Set(existing["ids"] as? [String] ?? []).union(row["ids"] as? [String] ?? [])).sorted()
                            } else if store == "images" {
                                let favorite = (existing["favorite"] as? Bool == true) || (row["favorite"] as? Bool == true)
                                row = existing; row["favorite"] = favorite
                            } else { continue }
                        }
                        try destination.put(store,row)
                    }
                }
            }
            for var info in assets {
                guard let key = info["key"] as? String, let digest = info["digest"] as? String, let size = info["size"] as? Int,
                    let account = info["account"] as? String, let id = info["id"] as? String, key == "\(account):\(id):original" else { throw StoreFailure.integrity }
                let file = source.root.appendingPathComponent("originals").appendingPathComponent(hash(key + ":" + digest))
                let bytes = try Data(contentsOf:file,options:.mappedIfSafe)
                guard bytes.count == size, hash(bytes) == digest else { throw StoreFailure.integrity }
                let existing = try destination.get("assetInfo",key)
                if existing?["digest"] as? String != digest || existing?["size"] as? Int != size {
                    let begun = try destination.handle(["op":"asset-begin","size":size]) as! [String:Any]
                    let token = begun["token"] as! String, staging = destination.root.appendingPathComponent("staging").appendingPathComponent(token)
                    try bytes.write(to:staging,options:.atomic)
                    info["pinned"] = try destination.get("images","\(account):\(id)")?["favorite"] as? Bool == true
                    _ = try destination.handle(["op":"asset-commit","token":token,"info":info,"digest":digest])
                }
                let favorite = try destination.get("images","\(account):\(id)")?["favorite"] as? Bool == true
                _ = try destination.handle(["op":"favorite","account":account,"id":id,"favorite":favorite])
                completed += 1
                try destination.put("migration",["key":"legacy-import","phase":"copying","completed":completed,"total":assets.count])
            }
            for store in ["accounts","images","views","hidden"] {
                for row in try source.all(store) {
                    guard let key = row["key"] as? String, let saved = try destination.get(store,key) else { throw StoreFailure.integrity }
                    if store == "images", row["favorite"] as? Bool == true, saved["favorite"] as? Bool != true { throw StoreFailure.integrity }
                    if store == "hidden", !Set(row["ids"] as? [String] ?? []).isSubset(of:Set(saved["ids"] as? [String] ?? [])) { throw StoreFailure.integrity }
                }
            }
            _ = try destination.handle(["op":"verify-assets"])
            try destination.put("migration",["key":"legacy-import","phase":"verified","completed":completed,"total":assets.count,"metadataVerified":true,"oldRetained":true])
            if let account = try source.all("accounts").sorted(by:{ ($0["lastSeen"] as? Double ?? 0) > ($1["lastSeen"] as? Double ?? 0) }).first?["key"] as? String {
                try destination.put("settings",["key":"connection","lastAccount":account])
            }
            total += completed
            } catch {
                try? destination.put("migration",["key":"legacy-import","phase":"paused","completed":completed,"total":assets.count,"error":StoreFailure.isSpace(error) ? "空间不足，迁移已暂停；旧数据仍保留。" : "导入未完成，请在 App 中重新选择同一导出目录续传。"])
                throw error
            }
        }
        guard !folders.isEmpty else { throw StoreFailure.invalid }
        return total
    }
}
