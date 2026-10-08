import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    static let queue = DispatchQueue(label: "images.native-store")
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let profile: String
        if #available(macOS 14.0, *) { profile = (item?.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default" }
        else { profile = "default" }
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String:Any]
        Self.queue.async {
            let result: [String:Any]
            do {
                guard let message, let group = Bundle.main.object(forInfoDictionaryKey: "ImagesGroup") as? String else { throw StoreFailure.invalid }
                let store = try NativeStore(group: group, profile: profile, probe: message["probe"] as? Bool == true)
                result = ["ok":true, "result":try store.handle(message)]
            } catch {
                let code = StoreFailure.isSpace(error) ? "QUOTA" : "NATIVE_STORAGE"
                result = ["ok":false, "code":code, "error":code == "QUOTA" ? "本地空间不足，缓存已暂停。" : "原生存储无法完成请求；原有数据未清理。"]
            }
            let response = NSExtensionItem(); response.userInfo = [SFExtensionMessageKey:result]
            context.completeRequest(returningItems:[response],completionHandler:nil)
        }
    }
}
