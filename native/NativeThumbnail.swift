import Foundation
import ImageIO
import UniformTypeIdentifiers

extension NativeStore {
    // Downsample beside the persistent original. Rebuildable files live in Caches;
    // only the resulting thumbnail crosses Safari's bounded messaging channel.
    func thumbnailInfo(_ request: [String:Any]) throws -> Any {
        guard let key = request["key"] as? String, let info = try get("assetInfo",key) else { return NSNull() }
        guard let digest = info["digest"] as? String, info["kind"] as? String == "original",
            let box = request["box"] as? [String:Any], let width = (box["width"] as? NSNumber)?.doubleValue,
            let height = (box["height"] as? NSNumber)?.doubleValue, let dpr = (box["dpr"] as? NSNumber)?.doubleValue,
            width > 0, height > 0, width <= 8192,
            (height <= 65536 || (height == 1e9 && box["cover"] as? Bool == false)),
            dpr > 0, dpr <= 4 else { throw StoreFailure.invalid }
        // Grid cards use an unbounded contain height to fit only their width.
        // The decoded raster remains capped below; cover requests stay bounded.
        let file = root.appendingPathComponent("originals").appendingPathComponent(Self.hash(key + ":" + digest))
        guard let source = CGImageSourceCreateWithURL(file as CFURL,[kCGImageSourceShouldCache:false] as CFDictionary),
            let properties = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
            let rawWidth = properties[kCGImagePropertyPixelWidth] as? Double,
            let rawHeight = properties[kCGImagePropertyPixelHeight] as? Double else { throw StoreFailure.integrity }
        let rotated = [5,6,7,8].contains(properties[kCGImagePropertyOrientation] as? Int ?? 1)
        let sourceWidth = rotated ? rawHeight : rawWidth, sourceHeight = rotated ? rawWidth : rawHeight
        // Save missing geometry during the native read, avoiding two extra Safari
        // messages per thumbnail. Merge under a transaction to preserve favorites.
        if let account = info["account"] as? String, let id = info["id"] as? String {
            try transaction {
                if var row = try get("images","\(account):\(id)"),
                    !((row["width"] as? Double ?? 0) > 0 && (row["height"] as? Double ?? 0) > 0) {
                    row["width"] = sourceWidth; row["height"] = sourceHeight; try put("images",row)
                }
            }
        }
        let ratio = (box["cover"] as? Bool == true ? max(width/sourceWidth,height/sourceHeight) : min(width/sourceWidth,height/sourceHeight)) * dpr
        let targetWidth = min(sourceWidth,ceil(sourceWidth * min(1,ratio) / 128) * 128)
        let targetHeight = max(1,round(sourceHeight * targetWidth / sourceWidth))
        let longest = min(4096,min(max(sourceWidth,sourceHeight),ceil(max(targetWidth,targetHeight)) + 2))
        let token = Self.hash(key + ":" + digest + ":v2:" + String(longest))
        let metadata = cacheRoot.appendingPathComponent(token + ".json"), asset = cacheRoot.appendingPathComponent(token)
        if let bytes = try? Data(contentsOf:metadata), let cached = try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],
            let size = cached["size"] as? Int,
            let content = try? Data(contentsOf:asset,options:.mappedIfSafe), content.count == size,
            Self.hash(content) == cached["digest"] as? String {
                var result = cached; result["geometryStored"] = true; return result
            }
        guard let image = CGImageSourceCreateThumbnailAtIndex(source,0,[
            kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,
            kCGImageSourceThumbnailMaxPixelSize:Int(longest),kCGImageSourceShouldCacheImmediately:true
        ] as CFDictionary) else { throw StoreFailure.integrity }
        let alpha = try hasTransparency(image), mime = alpha ? "image/png" : "image/jpeg"
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, (alpha ? UTType.png.identifier : UTType.jpeg.identifier) as CFString,1,nil) else { throw StoreFailure.integrity }
        CGImageDestinationAddImage(destination,image,[kCGImageDestinationLossyCompressionQuality:0.97] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw StoreFailure.integrity }
        let bytes = data as Data
        let result: [String:Any] = ["token":token,"size":bytes.count,"digest":Self.hash(bytes),"mime":mime,
            "width":image.width,"height":image.height,"sourceWidth":sourceWidth,"sourceHeight":sourceHeight,"thumbnailVersion":2,"geometryStored":true]
        try FileManager.default.createDirectory(at:cacheRoot,withIntermediateDirectories:true)
        try bytes.write(to:asset,options:.atomic)
        try JSONSerialization.data(withJSONObject:result).write(to:metadata,options:.atomic)
        return result
    }
    func thumbnailRead(_ request: [String:Any]) throws -> Any {
        guard let token = request["token"] as? String, token.count == 64, token.allSatisfy({ $0.isHexDigit }),
            let offset = request["offset"] as? Int, offset >= 0,
            let info = try JSONSerialization.jsonObject(with:Data(contentsOf:cacheRoot.appendingPathComponent(token + ".json"))) as? [String:Any],
            let size = info["size"] as? Int, offset <= size else { throw StoreFailure.invalid }
        let file = try FileHandle(forReadingFrom:cacheRoot.appendingPathComponent(token)); defer { try? file.close() }
        try file.seek(toOffset:UInt64(offset)); let data = try file.read(upToCount:262144) ?? Data()
        return ["data":data.base64EncodedString(),"size":size,"offset":offset]
    }
    private func hasTransparency(_ image: CGImage) throws -> Bool {
        if [.none,.noneSkipFirst,.noneSkipLast].contains(image.alphaInfo) { return false }
        var rgba = [UInt8](repeating:0,count:image.width * image.height * 4)
        return try rgba.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(data:buffer.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width * 4,
                space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw StoreFailure.integrity }
            context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height))
            return stride(from:3,to:buffer.count,by:4).contains { buffer[$0] != 255 }
        }
    }
}
