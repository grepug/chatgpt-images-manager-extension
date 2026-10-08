import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import ImagesManagerStorage

final class StorageTests: XCTestCase {
    var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("images-storage-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at:directory) }
    func store(_ name: String) throws -> NativeStore { try NativeStore(persistentRoot:directory.appendingPathComponent(name),cacheRoot:directory.appendingPathComponent(name + "-cache")) }
    func testBulkFlagsPreserveBytesAndAccountIsolation() throws {
        let s = try store("bulk")
        for id in ["a", "b"] { try s.put("images", ["key":"account:\(id)", "account":"account", "id":id, "favorite":false]) }
        try s.put("images", ["key":"other:a", "account":"other", "id":"a", "favorite":false])
        _ = try write(s, id:"a")
        let hidden = try s.handle(["op":"bulk-flags", "account":"account", "ids":["a","b","missing","a"], "kind":"hidden", "value":true]) as! [String:Any]
        XCTAssertEqual(hidden["succeeded"] as? [String], ["a","b"])
        XCTAssertEqual((hidden["failed"] as? [[String:String]])?.first?["id"], "missing")
        XCTAssertEqual(Set(try s.get("hidden","account")?["ids"] as! [String]), Set(["a","b"]))
        XCTAssertNil(try s.get("hidden","other"))
        for _ in 0..<2 { _ = try s.handle(["op":"bulk-flags", "account":"account", "ids":["a","b"], "kind":"favorite", "value":true]) }
        XCTAssertEqual(try s.get("images","account:a")?["saved"] as? Bool,true)
        XCTAssertEqual(try s.get("images","account:b")?["saved"] as? Bool,false)
        XCTAssertEqual(try s.get("images","other:a")?["favorite"] as? Bool,false)
        _ = try s.handle(["op":"bulk-flags", "account":"account", "ids":["a","b"], "kind":"favorite", "value":false])
        XCTAssertEqual(try s.get("assetInfo","account:a:original")?["pinned"] as? Bool,false)
        XCTAssertEqual((try s.handle(["op":"verify-assets"]) as! [String:Int])["verified"],1)
        _ = try s.handle(["op":"bulk-flags", "account":"account", "ids":["a","b"], "kind":"hidden", "value":false])
        XCTAssertEqual(try s.get("hidden","account")?["ids"] as? [String],[])
    }
    func testBulkRejectsInvalidArgumentsBeforeWriting() throws {
        let s = try store("bulk-invalid")
        for ids in [[], Array(repeating:"a",count:101), [""]] {
            XCTAssertThrowsError(try s.handle(["op":"bulk-flags", "account":"account", "ids":ids, "kind":"hidden", "value":true]))
        }
        XCTAssertNil(try s.get("hidden","account"))
    }
    func write(_ store: NativeStore, id: String = "picture", bytes: Data = Data("synthetic original".utf8)) throws -> [String:Any] {
        let token = (try store.handle(["op":"asset-begin","size":bytes.count]) as! [String:Any])["token"] as! String
        _ = try store.handle(["op":"asset-chunk","token":token,"offset":0,"data":bytes.base64EncodedString()])
        let info: [String:Any] = ["key":"account:\(id):original","account":"account","id":id,"kind":"original","mime":"image/png","size":bytes.count,"pinned":false]
        return try store.handle(["op":"asset-commit","token":token,"info":info,"digest":NativeStore.hash(bytes)]) as! [String:Any]
    }
    func testInterruptedRepliesCanRepeatChunkAndCommit() throws {
        let s = try store("repeat"), bytes = Data("synthetic".utf8)
        let token = (try s.handle(["op":"asset-begin","size":bytes.count]) as! [String:Any])["token"] as! String
        let chunk: [String:Any] = ["op":"asset-chunk","token":token,"offset":0,"data":bytes.base64EncodedString()]
        _ = try s.handle(chunk); _ = try s.handle(chunk)
        XCTAssertThrowsError(try s.handle(["op":"asset-chunk","token":token,"offset":0,"data":Data("different".utf8).base64EncodedString()]))
        let commit: [String:Any] = ["op":"asset-commit","token":token,"info":["key":"account:picture:original","account":"account","id":"picture","kind":"original","size":bytes.count],"digest":NativeStore.hash(bytes)]
        _ = try s.handle(commit); _ = try s.handle(commit)
        XCTAssertEqual((try s.handle(["op":"verify-assets"]) as! [String:Int])["verified"],1)
    }
    func testOriginalReadCombinesMetadataAndBoundedFrames() throws {
        let s = try store("read-frames"), bytes = Data(repeating:61,count:5242889)
        let token = (try s.handle(["op":"asset-begin","size":bytes.count]) as! [String:Any])["token"] as! String
        for offset in stride(from:0,to:bytes.count,by:262144) {
            _ = try s.handle(["op":"asset-chunk","token":token,"offset":offset,"data":bytes.subdata(in:offset..<min(offset+262144,bytes.count)).base64EncodedString()])
        }
        let digest = NativeStore.hash(bytes)
        _ = try s.handle(["op":"asset-commit","token":token,"info":["key":"account:large:original","account":"account","id":"large","kind":"original","mime":"image/png","size":bytes.count],"digest":digest])
        var restored = Data(), frames = 0
        while restored.count < bytes.count {
            let offset = restored.count
            let chunk = try s.handle(["op":"asset-read","key":"account:large:original","offset":offset,"length":4194304]) as! [String:Any]
            let data = Data(base64Encoded:chunk["data"] as! String)!
            XCTAssertLessThanOrEqual(data.count,4194304); XCTAssertEqual(chunk["offset"] as? Int,offset)
            XCTAssertEqual(chunk["digest"] as? String,digest); XCTAssertEqual(chunk["mime"] as? String,"image/png")
            restored.append(data); frames += 1
        }
        XCTAssertEqual(restored,bytes); XCTAssertEqual(frames,2)
        XCTAssertThrowsError(try s.handle(["op":"asset-read","key":"account:large:original","offset":0,"length":4194305]))
        XCTAssertThrowsError(try s.handle(["op":"asset-read","key":"account:large:original","offset":0,"length":0]))
        let legacy = try s.handle(["op":"asset-read","key":"account:large:original","offset":0]) as! [String:Any]
        XCTAssertEqual(Data(base64Encoded:legacy["data"] as! String)?.count,262144)
    }
    func testFailedNewWriteKeepsExistingOriginalAndFavorite() throws {
        let s = try store("favorite")
        try s.put("images",["key":"account:picture","account":"account","id":"picture","favorite":true])
        let info = try write(s)
        XCTAssertEqual(info["pinned"] as? Bool,true)
        XCTAssertEqual(try s.get("images","account:picture")?["localOriginal"] as? Bool,true)
        let token = (try s.handle(["op":"asset-begin","size":3]) as! [String:Any])["token"] as! String
        _ = try s.handle(["op":"asset-chunk","token":token,"offset":0,"data":"YWJj"])
        XCTAssertThrowsError(try s.handle(["op":"asset-commit","token":token,"info":info,"digest":"bad"]))
        _ = try s.handle(["op":"asset-abort","token":token])
        XCTAssertEqual(try s.get("assetInfo","account:picture:original")?["digest"] as? String,info["digest"] as? String)
        XCTAssertEqual((try s.handle(["op":"verify-assets"]) as! [String:Int])["verified"],1)
    }
    func export() throws -> (URL,NativeStore) {
        let profiles = directory.appendingPathComponent("profiles"), root = profiles.appendingPathComponent(NativeStore.hash("test-profile"))
        let s = try NativeStore(persistentRoot:root)
        try JSONSerialization.data(withJSONObject:["schema":1,"profile":"test-profile"]).write(to:root.appendingPathComponent("profile.json"))
        try s.put("accounts",["key":"account","lastSeen":1])
        try s.put("images",["key":"account:picture","account":"account","id":"picture","favorite":true])
        try s.put("hidden",["key":"account","ids":["old-hidden"]])
        try s.put("views",["key":"account","scrollTop":1234])
        _ = try write(s)
        try s.put("migration",["key":"legacy-export","phase":"verified"])
        return (profiles,s)
    }
    func testImportIsResumablePreservesNewStateAndCopiesExactBytes() throws {
        let (profiles,source) = try export(), target = try store("destination")
        try target.put("hidden",["key":"account","ids":["new-hidden"]])
        try target.put("views",["key":"account","scrollTop":5678])
        for _ in 0..<2 { XCTAssertEqual(try NativeStore.importLegacy(profiles) { _ in target },1) }
        XCTAssertEqual(Set(try target.get("hidden","account")?["ids"] as! [String]),Set(["old-hidden","new-hidden"]))
        XCTAssertEqual(try target.get("views","account")?["scrollTop"] as? Int,5678)
        XCTAssertEqual(try target.get("images","account:picture")?["favorite"] as? Bool,true)
        XCTAssertEqual(try target.get("images","account:picture")?["localOriginal"] as? Bool,true)
        XCTAssertEqual(try target.get("migration","legacy-import")?["phase"] as? String,"verified")
        XCTAssertEqual((try source.handle(["op":"verify-assets"]) as! [String:Int])["verified"],1)
        XCTAssertEqual((try target.handle(["op":"verify-assets"]) as! [String:Int])["verified"],1)
    }
    func testCorruptExportCannotCompleteOrRemoveExistingBytes() throws {
        let (profiles,source) = try export(), target = try store("corrupt-destination")
        _ = try write(target,id:"existing")
        let info = try source.get("assetInfo","account:picture:original")!
        let file = source.root.appendingPathComponent("originals").appendingPathComponent(NativeStore.hash("account:picture:original:" + (info["digest"] as! String)))
        try Data("corrupt".utf8).write(to:file)
        XCTAssertThrowsError(try NativeStore.importLegacy(profiles) { _ in target })
        XCTAssertEqual(try target.get("migration","legacy-import")?["phase"] as? String,"paused")
        XCTAssertNotNil(try target.get("assetInfo","account:existing:original"))
        XCTAssertNil(try target.get("assetInfo","account:picture:original"))
    }
    func testSummaryIncludesHiddenAndSeparatesRetainedOriginals() throws {
        let s = try store("summary")
        for id in ["visible","hidden","deleted","missing"] {
            try s.put("images",["key":"account:\(id)","account":"account","id":id,"deleted":id == "deleted"])
        }
        try s.put("hidden",["key":"account","ids":["hidden"]])
        for id in ["visible","hidden","deleted"] { _ = try write(s,id:id) }
        let summary = try s.handle(["op":"summary","account":"account"]) as! [String:Int]
        XCTAssertEqual(summary["total"],3); XCTAssertEqual(summary["completed"],2); XCTAssertEqual(summary["retained"],1)
    }
    func testDiskFullFromFilesystemAndNestedErrorsPausesDownloads() {
        XCTAssertTrue(StoreFailure.isSpace(NSError(domain:NSPOSIXErrorDomain,code:28)))
        XCTAssertTrue(StoreFailure.isSpace(NSError(domain:NSCocoaErrorDomain,code:CocoaError.Code.fileWriteOutOfSpace.rawValue)))
        XCTAssertTrue(StoreFailure.isSpace(NSError(domain:"wrapper",code:1,userInfo:[NSUnderlyingErrorKey:NSError(domain:NSPOSIXErrorDomain,code:69)])))
        XCTAssertFalse(StoreFailure.isSpace(StoreFailure.integrity))
    }
    func testVerificationPagesRemainBoundedAndDetectCorruption() throws {
        let s = try store("verify-page")
        for n in 0..<35 { _ = try write(s,id:String(format:"%02d",n)) }
        var after: String? = nil, verified = 0
        repeat {
            let page = try s.handle(["op":"verify-page","after":after ?? ""]) as! [String:Any]
            let count = page["verified"] as! Int; XCTAssertLessThanOrEqual(count,16); verified += count; after = page["after"] as? String
        } while after != nil
        XCTAssertEqual(verified,35)
        let info = try s.get("assetInfo","account:00:original")!
        try Data("corrupt".utf8).write(to:s.root.appendingPathComponent("originals").appendingPathComponent(NativeStore.hash("account:00:original:" + (info["digest"] as! String))))
        XCTAssertThrowsError(try s.handle(["op":"verify-page"]))
    }
    func testNativeThumbnailsHaveRetinaPixelsPreserveTransparencyAndNeverRewriteOriginals() throws {
        let s = try store("thumbnail")
        for alpha in [false,true] {
            let id = alpha ? "transparent" : "opaque"
            let context = CGContext(data:nil,width:1024,height:1408,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(CGColor(red:0.8,green:0.2,blue:0.4,alpha:alpha ? 0.5 : 1)); context.fill(CGRect(x:0,y:0,width:1024,height:1408))
            let image = context.makeImage()!, data = NSMutableData(), encoder = CGImageDestinationCreateWithData(data,UTType.png.identifier as CFString,1,nil)!
            CGImageDestinationAddImage(encoder,image,nil); XCTAssertTrue(CGImageDestinationFinalize(encoder))
            try s.put("images",["key":"account:\(id)","account":"account","id":id,"favorite":true])
            let original = try write(s,id:id,bytes:data as Data)
            let request: [String:Any] = ["op":"thumbnail-info","key":"account:\(id):original","box":["width":408,"height":1e9,"dpr":2,"cover":false]]
            let info = try s.handle(request) as! [String:Any]
            XCTAssertGreaterThanOrEqual(info["width"] as! Int,816)
            XCTAssertEqual(info["mime"] as? String,alpha ? "image/png" : "image/jpeg")
            XCTAssertEqual(info["geometryStored"] as? Bool,true)
            XCTAssertThrowsError(try s.handle(["op":"thumbnail-info","key":"account:\(id):original","box":["width":408,"height":1e9,"dpr":2,"cover":true]]))
            XCTAssertEqual(try s.get("images","account:\(id)")?["width"] as? Int,1024)
            XCTAssertEqual(try s.get("images","account:\(id)")?["favorite"] as? Bool,true)
            let cached = try s.handle(request) as! [String:Any]; XCTAssertEqual(info["token"] as? String,cached["token"] as? String)
            var restored = Data()
            while restored.count < info["size"] as! Int {
                let chunk = try s.handle(["op":"thumbnail-read","token":info["token"]!,"offset":restored.count]) as! [String:Any]
                let bytes = Data(base64Encoded:chunk["data"] as! String)!; XCTAssertLessThanOrEqual(bytes.count,262144); restored.append(bytes)
            }
            XCTAssertEqual(NativeStore.hash(restored),info["digest"] as? String)
            XCTAssertEqual(try s.get("assetInfo","account:\(id):original")?["digest"] as? String,original["digest"] as? String)
        }
        XCTAssertEqual((try s.handle(["op":"verify-assets"]) as! [String:Int])["verified"],2)
    }
}
