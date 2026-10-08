// swift-tools-version: 5.9
import PackageDescription
let package = Package(name:"ImagesManagerStorage",platforms:[.macOS(.v13)],products:[],targets:[
    .target(name:"ImagesManagerStorage",path:".",exclude:["Tests","AppDelegate.swift","SafariWebExtensionHandler.swift","legacy-export.html","legacy-export.css","legacy-export.js","legacy-cleanup.js","legacy-background.js"],sources:["NativeStore.swift","NativeThumbnail.swift","LegacyImport.swift"],linkerSettings:[.linkedLibrary("sqlite3")]),
    .testTarget(name:"StorageTests",dependencies:["ImagesManagerStorage"],path:"Tests")
])
