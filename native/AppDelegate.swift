import Cocoa
import Darwin

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(title:"存储"), item = NSMenuItem(title:"存储",action:nil,keyEquivalent:"")
        item.submenu = menu; NSApp.mainMenu?.addItem(item)
        let legacy = Bundle.main.object(forInfoDictionaryKey:"ImagesGroup") as? String == "legacy-export"
        let command = NSMenuItem(title:legacy ? "打开旧存储导出目录…" : "导入旧存储…",action:legacy ? #selector(showExport) : #selector(importStorage),keyEquivalent:"")
        command.target = self; menu.addItem(command)
        // Only synthetic cross-process proof; no account or picture data is logged.
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ImagesGroup") as? String,
            let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:group) else { return }
        let proof = container.appendingPathComponent("Library/Application Support/ImagesManager/validation")
        do {
            try FileManager.default.createDirectory(at:proof,withIntermediateDirectories:true)
            let value: [String:Any] = ["app":true,"nativeRead":FileManager.default.fileExists(atPath:proof.appendingPathComponent("native.json").path)]
            try JSONSerialization.data(withJSONObject:value).write(to:proof.appendingPathComponent("app.json"),options:.atomic)
        } catch { /* Validation result is checked from Safari, without sensitive logs. */ }
    }
    @objc private func showExport() {
        // The native extension exports inside its own sandbox, not the App's.
        // Finder opens that folder; importing still uses an explicit NSOpenPanel.
        let panel = NSOpenPanel(); panel.title = "打开旧存储导出的 profiles 目录"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.directoryURL = exportDirectory()
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        let access = folder.startAccessingSecurityScopedResource(); defer { if access { folder.stopAccessingSecurityScopedResource() } }
        NSWorkspace.shared.open(folder)
    }
    private func exportDirectory() -> URL? {
        guard let user = getpwuid(getuid()) else { return nil }
        return URL(fileURLWithPath:String(cString:user.pointee.pw_dir)).appendingPathComponent("Library/Containers/local.chatgpt.ChatGPT-Images-Manager.Extension/Data/Library/Application Support/ImagesManagerLegacy/profiles")
    }
    @objc private func importStorage() {
        let panel = NSOpenPanel(); panel.title = "选择旧存储导出的 profiles 目录"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.directoryURL = exportDirectory()
        guard panel.runModal() == .OK, let directory = panel.url,
            let group = Bundle.main.object(forInfoDictionaryKey:"ImagesGroup") as? String else { return }
        let access = directory.startAccessingSecurityScopedResource()
        DispatchQueue.global(qos:.utility).async {
            defer { if access { directory.stopAccessingSecurityScopedResource() } }
            let message: String
            do { let count = try NativeStore.importLegacy(directory,group:group); message = "已复制并核对 \(count) 张原图。旧存储和导出副本均保留。请刷新图片库。" }
            catch { message = "导入未完成。旧存储仍保留，可重新选择同一目录续传；请检查剩余磁盘空间和导出是否完整。" }
            DispatchQueue.main.async { let alert = NSAlert(); alert.messageText = message; alert.runModal() }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication) -> Bool { true }
}
