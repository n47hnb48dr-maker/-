if (location.protocol === 'https:' && location.hostname !== 'appassets.androidplatform.net' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
