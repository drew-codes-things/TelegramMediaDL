// ==UserScript==
// @name         Telegram Web Media Downloader
// @author       drew-codes-things
// @version      1.1.0
// @description  Download photos and videos from Telegram Web, one by one, in batches, or via a scan-and-pick list of what's loaded or of the whole chat - even in restricted "no-forwards" chats. Also re-enables copying text from protected messages.
// @match        https://web.telegram.org/*
// @match        https://webk.telegram.org/*
// @match        https://webz.telegram.org/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const onWebK = location.hostname === 'webk.telegram.org' || location.pathname.startsWith('/k/');
    if (!onWebK) {
        location.replace('https://web.telegram.org/k/' + location.hash);
        return;
    }

    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const BATCH_GAP_MS = 1000;
    const BATCH_LABEL = 'Download';
    const SCAN_LABEL = 'Scan';
    const SCAN_ALL_LABEL = 'Scan all';
    const NOTHING_FOUND_LABEL = 'N/A';
    const LABEL_FLASH_MS = 1500;
    const SCAN_STEP_WAIT_MS = 700;
    const SCAN_QUIET_STEPS_TO_FINISH = 4;
    const SCAN_MAX_MEDIA = 5000;
    const SCAN_MAX_MINUTES = 15;
    const SCAN_MAX_MS = SCAN_MAX_MINUTES * 60 * 1000;
    const WHOLE_CHAT_NOTE = 'Whole chat scanned.';

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const mediaOf = (msg) => msg && msg.media && (msg.media.document || msg.media.photo);
    const lookup = (peerId, mid) => page.mtprotoMessagePort?.getMessageByPeer(peerId, +mid);
    const escapeHtml = (str) => str.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    async function download(msg) {
        const media = mediaOf(msg);
        const dm = page.appDownloadManager;
        if (!dm) { console.warn('[tg-save] appDownloadManager missing - WebK internals changed?'); return; }
        if (media) await dm.downloadToDisc({ media });
    }

    async function downloadMany(messages, limit, onProgress) {
        let index = 0;
        let done = 0;
        async function lane() {
            while (index < messages.length) {
                const msg = messages[index++];
                try { await download(msg); } catch (err) { console.warn('[tg-save] download failed', err); }
                done++;
                onProgress?.(done, messages.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, messages.length) }, lane));
    }

    let pending = null;

    document.addEventListener('mouseup', (e) => {
        pending = null;
        if (e.button !== 2) return;
        const bubble = e.target.closest('[data-mid]');
        if (!bubble || !bubble.closest('.no-forwards')) return;
        if (mediaOf(lookup(bubble.dataset.peerId, bubble.dataset.mid))) {
            pending = { peerId: bubble.dataset.peerId, mid: bubble.dataset.mid };
        }
    });

    function addDownloadItem(menu) {
        const first = menu.querySelector('.btn-menu-item');
        if (!pending || !first || menu.querySelector('#nk-tg-down')) return;
        const { peerId, mid } = pending;
        first.insertAdjacentHTML('beforebegin',
            '<div class="btn-menu-item rp-overflow" id="nk-tg-down">' +
            '<span class="btn-menu-item-text">Download</span></div>');
        menu.querySelector('#nk-tg-down').addEventListener('click',
            () => download(lookup(peerId, mid)).catch((err) => console.warn('[tg-save] download failed', err)));
    }

    function addBatchButton(wrapper) {
        const bar = wrapper.querySelector('.selection-container');
        if (!bar || bar.querySelector('#nk-tg-batch')) return;
        bar.insertAdjacentHTML('beforeend',
            '<button id="nk-tg-batch" class="btn-primary btn-transparent text-bold" title="Download selected media" style="cursor:pointer;width:auto;">' +
            '<span class="nk-txt">' + BATCH_LABEL + '</span></button>');
        bar.querySelector('#nk-tg-batch').addEventListener('click', downloadSelected);
    }

    async function downloadSelected() {
        const sel = page.appImManager?.chat?.selection;
        const txt = document.querySelector('#nk-tg-batch .nk-txt');
        const media = ((await sel?.getSelectedMessages()) || []).filter(mediaOf);
        if (!media.length) { txt.textContent = 'N/A'; await delay(1500); txt.textContent = BATCH_LABEL; return; }

        const btn = document.getElementById('nk-tg-batch');
        btn.disabled = true; btn.style.opacity = 0.6;
        for (let i = 0; i < media.length; i++) {
            txt.textContent = (i + 1) + '/' + media.length;
            try { await download(media[i]); } catch (err) { console.warn('[tg-save] batch item failed', err); }
            if (i < media.length - 1) await delay(BATCH_GAP_MS);
        }
        btn.disabled = false; btn.style.opacity = 1; txt.textContent = BATCH_LABEL;
        sel?.cancelSelection();
    }

    function getChatBubbles() {
        return Array.from(document.querySelectorAll('.bubbles [data-mid]'));
    }

    function describeMedia(msg) {
        const caption = (msg.message || '').trim();
        if (caption) return caption;
        const media = mediaOf(msg);
        if (media?.file_name) return media.file_name;
        if (msg.media?.photo) return 'Photo';
        return media?.type === 'video' ? 'Video' : (media?.type || 'File');
    }

    function scanChatMedia() {
        const seen = new Set();
        const found = [];
        for (const bubble of getChatBubbles()) {
            const { peerId, mid } = bubble.dataset;
            const key = peerId + ':' + mid;
            if (seen.has(key)) continue;
            seen.add(key);
            const msg = lookup(peerId, mid);
            if (!mediaOf(msg)) continue;
            found.push({ msg, name: describeMedia(msg) });
        }
        return found;
    }

    const currentPeer = () => String(page.appImManager?.chat?.peerId ?? '');

    function findChatScroller() {
        const scroller = document.querySelector('.bubbles .scrollable-y');
        if (scroller) return scroller;
        let node = document.querySelector('.bubbles [data-mid]');
        while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight) return node;
            node = node.parentElement;
        }
        return null;
    }

    function collectLoadedMedia(found, peerId) {
        for (const bubble of getChatBubbles()) {
            if (bubble.dataset.peerId !== peerId) continue;
            const mid = +bubble.dataset.mid;
            if (found.has(mid)) continue;
            const msg = lookup(peerId, mid);
            if (mediaOf(msg)) found.set(mid, { msg, name: describeMedia(msg) });
        }
    }

    function renderedSpan() {
        const bubbles = getChatBubbles();
        if (!bubbles.length) return '';
        return bubbles[0].dataset.mid + '-' + bubbles[bubbles.length - 1].dataset.mid + '-' + bubbles.length;
    }

    function scanStopReason(scan, found) {
        const peer = currentPeer();
        if (scan.stopped) return 'Stopped early: the list only has what was found so far.';
        if (peer && peer !== scan.peerId) return 'Stopped early: the chat changed.';
        if (found.size >= SCAN_MAX_MEDIA) return 'Stopped early at ' + SCAN_MAX_MEDIA + ' media.';
        if (Date.now() - scan.startedAt > SCAN_MAX_MS) return 'Stopped early after ' + SCAN_MAX_MINUTES + ' minutes.';
        return '';
    }

    async function sweepChat(scroller, towardsOldest, found, scan, onProgress) {
        let quietSteps = 0;
        while (quietSteps < SCAN_QUIET_STEPS_TO_FINISH) {
            const reason = scanStopReason(scan, found);
            if (reason) return reason;
            const before = renderedSpan();
            scroller.scrollTop = towardsOldest ? 0 : scroller.scrollHeight;
            await delay(SCAN_STEP_WAIT_MS);
            quietSteps = renderedSpan() === before ? quietSteps + 1 : 0;
            collectLoadedMedia(found, scan.peerId);
            onProgress(found.size);
        }
        return '';
    }

    function showScanStatus(scan) {
        const panel = document.createElement('div');
        panel.id = 'nk-tg-scan-status';
        const text = document.createElement('span');
        const stop = document.createElement('button');
        stop.id = 'nk-tg-scan-stop';
        stop.className = 'nk-tg-btn nk-tg-btn-secondary';
        stop.textContent = 'Stop';
        stop.addEventListener('click', () => {
            scan.stopped = true;
            stop.disabled = true;
            stop.textContent = 'Stopping...';
        });
        panel.append(text, stop);
        document.body.appendChild(panel);
        return (count) => { text.textContent = 'Scanning the whole chat: ' + count + ' found'; };
    }

    function flashLabel(button, label) {
        button.textContent = NOTHING_FOUND_LABEL;
        setTimeout(() => { button.textContent = label; }, LABEL_FLASH_MS);
    }

    let activeScan = null;

    async function scanWholeChat(button) {
        if (activeScan) return;
        const scroller = findChatScroller();
        if (!scroller) { flashLabel(button, SCAN_ALL_LABEL); return; }

        const scan = { peerId: currentPeer() || getChatBubbles()[0]?.dataset.peerId || '', startedAt: Date.now(), stopped: false };
        const found = new Map();
        activeScan = scan;
        button.disabled = true;
        const showProgress = showScanStatus(scan);
        let reason = '';
        try {
            collectLoadedMedia(found, scan.peerId);
            showProgress(found.size);
            reason = await sweepChat(scroller, true, found, scan, showProgress) ||
                await sweepChat(scroller, false, found, scan, showProgress);
        } finally {
            document.getElementById('nk-tg-scan-status')?.remove();
            button.disabled = false;
            activeScan = null;
        }

        const items = Array.from(found.entries()).sort((a, b) => a[0] - b[0]).map(([, item]) => item);
        if (!items.length) { flashLabel(button, SCAN_ALL_LABEL); return; }
        openScanPicker(items, reason || WHOLE_CHAT_NOTE);
    }

    function openScanPicker(items, note) {
        const overlay = document.createElement('div');
        overlay.id = 'nk-tg-scan-overlay';

        const rows = items.map((item, i) =>
            '<label class="nk-tg-row">' +
            '<input type="checkbox" class="nk-scan-item" data-i="' + i + '" checked>' +
            '<span>' + escapeHtml(item.name) + '</span></label>'
        ).join('');

        overlay.innerHTML =
            '<div class="nk-tg-panel">' +
            '<div class="nk-tg-title">Select media to download (' + items.length + ' found)</div>' +
            (note ? '<div class="nk-tg-note">' + escapeHtml(note) + '</div>' : '') +
            '<div id="nk-tg-scan-list">' + rows + '</div>' +
            '<div class="nk-tg-actions">' +
            '<button id="nk-tg-scan-cancel" class="nk-tg-btn nk-tg-btn-secondary">Cancel</button>' +
            '<button id="nk-tg-scan-go" class="nk-tg-btn">Download Selected</button>' +
            '</div></div>';

        document.body.appendChild(overlay);

        overlay.addEventListener('mousedown', (e) => e.stopPropagation());
        overlay.addEventListener('click', (e) => e.stopPropagation());
        overlay.querySelector('#nk-tg-scan-list').addEventListener('click', (e) => {
            const label = e.target.closest('label');
            const cb = label?.querySelector('.nk-scan-item');
            if (!cb) return;
            e.preventDefault();
            cb.checked = !cb.checked;
        });

        overlay.querySelector('#nk-tg-scan-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#nk-tg-scan-go').addEventListener('click', async () => {
            const goBtn = overlay.querySelector('#nk-tg-scan-go');
            const checked = Array.from(overlay.querySelectorAll('.nk-scan-item:checked'))
                .map((cb) => items[+cb.dataset.i].msg);
            if (!checked.length) return;

            goBtn.disabled = true;
            overlay.querySelector('#nk-tg-scan-cancel').disabled = true;
            await downloadMany(checked, 1, (done, total) => {
                goBtn.textContent = done + '/' + total;
            });
            overlay.remove();
        });
    }

    function addFloatingButton(id, label, title, onClick) {
        if (document.getElementById(id)) return;
        const btn = document.createElement('button');
        btn.id = id;
        btn.title = title;
        btn.textContent = label;
        btn.addEventListener('click', () => onClick(btn));
        document.body.appendChild(btn);
    }

    function addScanButtons() {
        addFloatingButton('nk-tg-scan', SCAN_LABEL, 'Scan the loaded part of this chat for media to download', (btn) => {
            const items = scanChatMedia();
            if (!items.length) { flashLabel(btn, SCAN_LABEL); return; }
            openScanPicker(items);
        });
        addFloatingButton('nk-tg-scan-all', SCAN_ALL_LABEL, 'Scroll through the whole chat and list every photo and video',
            (btn) => scanWholeChat(btn).catch((err) => console.warn('[tg-save] scan all failed', err)));
    }

    document.addEventListener('copy', (e) => {
        const node = getSelection()?.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (el?.closest('.no-forwards')) e.stopImmediatePropagation();
    }, true);

    const GRADIENT_STYLE = `
#nk-tg-scan, #nk-tg-scan-all {
    position: fixed; bottom: 5rem; right: 1.5rem; z-index: 9999; height: 2.5rem; padding: 0 1.1rem;
    border-radius: 999px; border: 1px solid transparent; cursor: pointer;
    background: linear-gradient(135deg, #e5383b, #7a0f14); color: #fff;
    font: 500 .9rem 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .45); transition: filter .15s ease;
}
#nk-tg-scan-all { bottom: 8.25rem; }
#nk-tg-scan:hover, #nk-tg-scan-all:hover { filter: brightness(1.12); }
#nk-tg-scan-all:disabled { opacity: .6; cursor: default; filter: none; }
#nk-tg-scan-status {
    position: fixed; bottom: 11.5rem; right: 1.5rem; z-index: 9999; display: flex; align-items: center; gap: .75rem;
    padding: .6rem .8rem; border-radius: 14px; border: 1px solid rgba(255, 255, 255, .14);
    background: linear-gradient(165deg, #1c0608 0%, #0d0b0c 42%, #070708 100%); color: #ececec;
    font: .85rem/1.4 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .45);
}
.nk-tg-note { margin: -.3rem 0 .6rem; color: #a1a1a6; font-size: .85rem; }
#nk-tg-scan-overlay {
    position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, .55); backdrop-filter: blur(4px);
}
.nk-tg-panel {
    max-width: 28rem; max-height: 80vh; overflow: auto; padding: 1.1rem 1.2rem;
    background: radial-gradient(120% 70% at 0% 0%, rgba(160, 20, 28, .38), transparent 60%), linear-gradient(165deg, #1c0608 0%, #0d0b0c 42%, #070708 100%);
    color: #ececec; border: 1px solid rgba(255, 255, 255, .14); border-radius: 16px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, .45);
    font: .9rem/1.5 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
}
.nk-tg-title { font-weight: 600; margin-bottom: .6rem; color: #f5c2c3; }
.nk-tg-row {
    display: flex; align-items: flex-start; gap: .5rem; padding: .35rem .5rem; overflow-wrap: anywhere;
    border-radius: 10px; cursor: pointer;
}
.nk-tg-row:hover { background: rgba(255, 255, 255, .07); }
.nk-tg-row input { accent-color: #e5383b; margin-top: .25rem; }
.nk-tg-actions { display: flex; gap: .5rem; margin-top: 1rem; justify-content: flex-end; }
.nk-tg-btn {
    padding: .5rem 1rem; border-radius: 12px; border: 1px solid transparent; cursor: pointer; color: #fff;
    background: linear-gradient(135deg, #e5383b, #7a0f14); font-family: inherit; font-size: .85rem; font-weight: 500;
    transition: filter .15s ease;
}
.nk-tg-btn:hover { filter: brightness(1.12); }
.nk-tg-btn:disabled { opacity: .6; cursor: default; filter: none; }
.nk-tg-btn-secondary { background: rgba(255, 255, 255, .07); border-color: rgba(255, 255, 255, .14); color: #a1a1a6; }
.nk-tg-btn-secondary:hover { filter: none; background: rgba(255, 255, 255, .11); color: #ececec; }
@media (prefers-reduced-motion: reduce) { #nk-tg-scan, #nk-tg-scan-all, .nk-tg-btn { transition: none; } }
`;

    const style = document.createElement('style');
    style.textContent = '.bubble.no-forwards,.bubble.no-forwards *' +
        '{-webkit-user-select:text!important;user-select:text!important}' + GRADIENT_STYLE;
    (document.head || document.documentElement).appendChild(style);

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.id === 'bubble-contextmenu') addDownloadItem(node);
                else if (node.classList.contains('selection-wrapper')) addBatchButton(node);
            }
        }
    });
    const start = () => {
        observer.observe(document.body, { childList: true, subtree: true });
        addScanButtons();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
