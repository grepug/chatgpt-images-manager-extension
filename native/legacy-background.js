import { installNativeBroker } from '../extension/native-storage.js';
installNativeBroker();
const extension = globalThis.browser || globalThis.chrome;
extension.action.onClicked.addListener(() => extension.tabs.create({ url: extension.runtime.getURL('library.html') }));
