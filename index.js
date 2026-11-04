import { describe, errorMessage, getProfiles, SYSTEM_PROMPT, ACCESSORIES_PROMPT } from './api.js';
import { createCropEditor } from './crop.js';

const KEY = 'pinClothes';
const context = () => SillyTavern.getContext();
let dialog;
let image = '';
let fullImage = '';
let cropRect;
let originalFile;
let imageVersion = 0;
let loadingImage = false;
let activeRequest;
let inserting = false;
let returnFocus;
let ui;
let fieldNumber = 0;

function settings() {
    const store = context().extensionSettings;
    store[KEY] ??= { profileId: '', maxTokens: 2048 };
    return store[KEY];
}

function saveSettings() {
    context().saveSettingsDebounced();
}

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function button(text, action) {
    const element = node('button', 'pc-button', text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
}

function icon(name) {
    const paths = {
        close: 'M6 6l12 12M18 6L6 18',
        settings: 'M4 7h16M4 17h16M9 4v6M15 14v6',
        arrow: 'M7 17L17 7M7 7h10v10',
        image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 16l5-5 5 5 3-3 5 5M15 7h.01',
        refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
        download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
        trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
        copy: 'M9 9h12v12H9zM15 5V3H3v12h2',
        crop: 'M6 3v15h15M3 6h15v15',
        shirt: 'm8 3-5 3-2 5 5 2v8h12v-8l5-2-2-5-5-3c0 4-8 4-8 0Z',
        glasses: 'M3 13 5 6h3M21 13l-2-7h-3M9 14c2-2 4-2 6 0M9 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM23 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
        spark: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('pc-icon');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[name]);
    svg.append(path);
    return svg;
}

function iconButton(label, name, action) {
    const element = button('', action);
    element.classList.add('pc-icon-button');
    element.setAttribute('aria-label', label);
    element.title = label;
    element.append(icon(name));
    return element;
}

function showView(view) {
    ui.view = view;
    for (const [name, panel] of Object.entries(ui.panels)) panel.hidden = name !== view;
    for (const [name, tab] of Object.entries(ui.tabs)) {
        tab.setAttribute('aria-selected', String(name === view));
        tab.tabIndex = name === view || (view === 'settings' && name === 'outfit') ? 0 : -1;
    }
    ui.settingsButton.setAttribute('aria-expanded', String(view === 'settings'));
    ui.settingsButton.disabled = view === 'crop';
    ui.tabBar.hidden = view === 'crop';
    ui.body.scrollTop = 0;
    syncButtons();
}

function field(label, input) {
    const element = node('label', 'pc-field');
    const caption = node('span', '', label);
    caption.id = `pc-field-label-${++fieldNumber}`;
    input.setAttribute('aria-labelledby', caption.id);
    element.append(caption, input);
    return element;
}

function status(text, error = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle('pc-error', error);
}

function syncButtons() {
    const busy = Boolean(activeRequest);
    ui.generate.disabled = busy || loadingImage || !image || !ui.profile.value;
    ui.cancel.hidden = !busy;
    ui.profile.disabled = busy;
    ui.refresh.disabled = busy;
    ui.comment.disabled = busy;
    for (const option of ui.scopeOptions) option.disabled = busy;
    ui.tokens.disabled = busy;
    ui.file.disabled = busy;
    ui.drop.disabled = busy || loadingImage;
    ui.clear.disabled = busy || loadingImage || !image;
    ui.crop.disabled = busy || loadingImage || !image;
    ui.download.disabled = !originalFile;
    ui.copy.disabled = inserting || !ui.result.value.trim();
    ui.insert.disabled = inserting || !ui.result.value.trim();
    ui.imageActions.hidden = !image;
    ui.drop.classList.toggle('pc-has-image', Boolean(image));
    ui.resultEmpty.hidden = Boolean(ui.result.value.trim());
    ui.outputActions.hidden = busy || ui.view !== 'result';
    ui.cropEditor.actions.hidden = ui.view !== 'crop';
    ui.generateActions.hidden = !busy && ui.view !== 'outfit';
    ui.generate.hidden = busy;
    ui.generate.textContent = loadingImage ? 'Подготовка фото…' : 'Описать одежду';
    dialog.setAttribute('aria-busy', String(busy || loadingImage));
}

function refreshProfiles() {
    const saved = settings().profileId;
    ui.profile.replaceChildren(new Option('Выбери профиль vision-модели', ''));
    try {
        const profiles = getProfiles(context());
        for (const profile of profiles) {
            ui.profile.add(new Option(`${profile.name || profile.id}${profile.model ? ` · ${profile.model}` : ''}`, profile.id));
        }
        const preferred = saved || context().extensionSettings.connectionManager?.selectedProfile;
        if (profiles.some(profile => profile.id === preferred)) ui.profile.value = preferred;
        if (!profiles.length) status('Создай профиль Chat Completion в «Профилях подключения» и включи Connection Manager.', true);
        else if (saved && !profiles.some(profile => profile.id === saved)) status('Сохранённый профиль удалён или недоступен. Выбери другой.', true);
    } catch (error) {
        status(errorMessage(error), true);
    }
    syncButtons();
}

async function prepareImage(file) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
        throw new Error('Поддерживаются JPG, PNG, WebP и GIF. Для GIF используется первый кадр.');
    }
    if (file.size > 25 * 1024 * 1024) throw new Error('Изображение слишком большое. Максимум — 25 МБ.');
    const url = URL.createObjectURL(file);
    try {
        const source = new Image();
        source.src = url;
        await source.decode();
        const scale = Math.min(1, 2048 / Math.max(source.naturalWidth, source.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
        const painter = canvas.getContext('2d');
        painter.fillStyle = '#ffffff';
        painter.fillRect(0, 0, canvas.width, canvas.height);
        painter.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.9);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function loadImage(file) {
    if (!file || activeRequest || ui.view === 'crop') return;
    const version = ++imageVersion;
    loadingImage = true;
    status('Подготавливаю изображение…');
    syncButtons();
    try {
        const prepared = await prepareImage(file);
        if (version !== imageVersion) return;
        image = prepared;
        fullImage = prepared;
        cropRect = undefined;
        originalFile = file;
        ui.preview.src = image;
        ui.preview.hidden = false;
        ui.placeholder.hidden = true;
        ui.filename.textContent = file.name || 'Изображение из буфера';
        ui.result.value = '';
        status('Фото готово к описанию.');
        if (dialog.open) openCrop();
    } catch (error) {
        if (version === imageVersion) status(errorMessage(error), true);
    } finally {
        if (version === imageVersion) {
            loadingImage = false;
            ui.file.value = '';
            syncButtons();
        }
    }
}

function clearImage() {
    imageVersion++;
    loadingImage = false;
    image = '';
    fullImage = '';
    cropRect = undefined;
    originalFile = undefined;
    ui.preview.removeAttribute('src');
    ui.preview.hidden = true;
    ui.placeholder.hidden = false;
    ui.filename.textContent = '';
    ui.result.value = '';
    ui.file.value = '';
    status('Прикрепи картинку с одеждой.');
    syncButtons();
}

function openCrop() {
    if (!fullImage || activeRequest) return;
    showView('crop');
    ui.cropEditor.open(fullImage, cropRect);
    ui.cropEditor.actions.querySelector('button').focus({ preventScroll: true });
    status('Оставь в рамке нужную часть фото или нажми «Отмена».');
}

function cancelCrop() {
    showView('outfit');
    ui.crop.focus({ preventScroll: true });
    status('Фото оставлено без изменений.');
}

function openPinterest() {
    const query = ui.search.value.trim();
    const url = query ? `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}` : 'https://www.pinterest.com/';
    // A real browsing window supports login and downloads; Pinterest blocks iframes.
    window.open(url, '_blank', 'popup,width=1100,height=850,noopener,noreferrer');
    status('Скачай фото в Pinterest и прикрепи его здесь.');
}

async function generate() {
    if (activeRequest || loadingImage || !image || ui.view === 'crop') return;
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Время ожидания истекло (120 секунд). Попробуй ещё раз.', 'TimeoutError')), 120000);
    settings().profileId = ui.profile.value;
    saveSettings();
    status('Модель рассматривает изображение…');
    syncButtons();
    try {
        const result = await describe(context(), {
            profileId: ui.profile.value,
            image,
            comment: ui.comment.value,
            includeAccessories: settings().includeAccessories === true,
            maxTokens: Number(ui.tokens.value),
            signal: controller.signal,
        });
        ui.result.value = result;
        showView('result');
        if (dialog.open) ui.tabs.result.focus({ preventScroll: true });
        status('Готово — текст можно отредактировать.');
    } catch (error) {
        const reason = controller.signal.reason;
        if (controller.signal.aborted && reason?.name !== 'TimeoutError') status('Запрос отменён.');
        else status(errorMessage(reason || error), true);
    } finally {
        clearTimeout(timeout);
        activeRequest = undefined;
        syncButtons();
    }
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const temporary = node('textarea');
        temporary.value = text;
        temporary.style.cssText = 'position:fixed;opacity:0;pointer-events:none;font-size:16px';
        dialog.append(temporary);
        try {
            temporary.focus({ preventScroll: true });
            temporary.select();
            return document.execCommand('copy');
        } catch {
            return false;
        } finally {
            temporary.remove();
        }
    }
}

async function copyResult() {
    if (await copyText(ui.result.value.trim())) status('Описание скопировано.');
    else {
        ui.result.focus();
        ui.result.select();
        status('Текст выделен — скопируй его вручную.', true);
    }
}

async function insertResult() {
    if (inserting) return;
    const input = document.getElementById('send_textarea');
    if (!input || input.disabled) return status('Поле сообщения сейчас недоступно.', true);
    const text = ui.result.value.trim();
    if (!text) return;
    inserting = true;
    syncButtons();
    input.value = `${input.value}${input.value && !input.value.endsWith('\n') ? '\n' : ''}${text}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const copied = await copyText(text);
    inserting = false;
    syncButtons();
    if (copied) {
        dialog.close();
        input.focus();
    } else {
        status('В сообщение добавлено, но копирование не удалось. Нажми «Копировать» или скопируй текст вручную.', true);
    }
}

function downloadImage() {
    if (!originalFile) return;
    const url = URL.createObjectURL(originalFile);
    const link = node('a');
    link.href = url;
    link.download = originalFile.name || 'pinterest-image.png';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function createDialog() {
    dialog = node('dialog', 'pc-dialog');
    dialog.id = 'pinclothes-dialog';
    dialog.setAttribute('aria-labelledby', 'pc-title');
    const header = node('header', 'pc-header');
    const brand = node('div', 'pc-heading');
    const title = node('h2', '', 'Pinterest');
    title.id = 'pc-title';
    const headingText = node('div');
    headingText.append(title, node('p', 'pc-subtitle', 'Из картинки — в описание'));
    const logo = node('span', 'pc-brand');
    logo.append(node('span', 'pc-pinterest-icon'));
    logo.setAttribute('aria-hidden', 'true');
    brand.append(logo, headingText);
    ui = { panels: {}, tabs: {}, view: 'outfit' };
    ui.settingsButton = iconButton('Настройки Pinterest', 'settings', () => showView(ui.view === 'settings' ? 'outfit' : 'settings'));
    ui.settingsButton.setAttribute('aria-controls', 'pc-panel-settings');
    const close = iconButton('Закрыть', 'close', () => dialog.close());
    close.autofocus = true;
    const headerActions = node('div', 'pc-actions');
    headerActions.append(ui.settingsButton, close);
    header.append(brand, headerActions);
    const tabs = node('div', 'pc-tabs');
    ui.tabBar = tabs;
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Pinterest');
    for (const [name, label] of [['outfit', 'Образ'], ['result', 'Результат']]) {
        const tab = button(label, () => showView(name));
        tab.id = `pc-tab-${name}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `pc-panel-${name}`);
        tab.addEventListener('keydown', event => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 'outfit' : event.key === 'End' ? 'result' : name === 'outfit' ? 'result' : 'outfit';
                showView(next);
                ui.tabs[next].focus();
            }
        });
        ui.tabs[name] = tab;
        tabs.append(tab);
    }
    ui.body = node('div', 'pc-body');
    for (const name of ['outfit', 'result', 'settings']) {
        const panel = node('section', 'pc-panel');
        panel.id = `pc-panel-${name}`;
        if (name !== 'settings') {
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', `pc-tab-${name}`);
        }
        ui.panels[name] = panel;
        ui.body.append(panel);
    }
    const outfit = ui.panels.outfit;
    const pinterest = node('div', 'pc-search');
    ui.search = node('input', 'pc-input');
    ui.search.placeholder = 'Найти образ в Pinterest';
    ui.search.setAttribute('aria-label', 'Поиск в Pinterest');
    ui.search.type = 'search';
    ui.search.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); openPinterest(); }
    });
    pinterest.append(ui.search, iconButton('Открыть Pinterest', 'arrow', openPinterest));
    const upload = node('div', 'pc-upload');
    const drop = button('', () => ui.file.click());
    ui.drop = drop;
    drop.classList.add('pc-drop');
    drop.setAttribute('aria-label', 'Выбрать фото');
    ui.placeholder = node('span', 'pc-upload-placeholder');
    ui.placeholder.append(icon('image'), node('strong', '', 'Добавить фото'), node('span', 'pc-hint', 'Из галереи или файлов'));
    ui.preview = node('img', 'pc-preview');
    ui.preview.alt = 'Прикреплённое изображение одежды';
    ui.preview.hidden = true;
    drop.append(ui.placeholder, ui.preview);
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('pc-drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('pc-drag'));
    drop.addEventListener('drop', event => {
        event.preventDefault();
        drop.classList.remove('pc-drag');
        void loadImage(event.dataTransfer.files[0]);
    });
    ui.file = node('input', 'pc-file');
    ui.file.type = 'file';
    ui.file.hidden = true;
    ui.file.setAttribute('aria-label', 'Выбрать файл');
    ui.file.accept = 'image/jpeg,image/png,image/webp,image/gif';
    ui.file.addEventListener('change', () => void loadImage(ui.file.files[0]));
    ui.filename = node('div', 'pc-hint pc-filename');
    ui.clear = iconButton('Убрать', 'trash', clearImage);
    ui.crop = iconButton('Обрезать фото', 'crop', openCrop);
    ui.download = iconButton('Скачать оригинал', 'download', downloadImage);
    ui.imageActions = node('div', 'pc-image-actions');
    ui.imageActions.append(ui.filename, ui.crop, ui.download, ui.clear);
    upload.append(drop, ui.file, ui.imageActions);

    ui.profile = node('select', 'pc-input');
    ui.profile.addEventListener('change', () => {
        settings().profileId = ui.profile.value;
        saveSettings();
        syncButtons();
    });
    ui.refresh = iconButton('Обновить профили', 'refresh', refreshProfiles);
    const profileRow = node('div', 'pc-profile-row');
    profileRow.append(field('Профиль подключения', ui.profile), ui.refresh);
    const scope = node('div', 'pc-scope');
    scope.setAttribute('role', 'group');
    scope.setAttribute('aria-label', 'Что описывать');
    ui.scopeOptions = [];
    ui.rule = node('p', 'pc-hint pc-rule');
    ui.prompt = node('pre', 'pc-prompt');
    const updateScope = () => {
        const enabled = settings().includeAccessories === true;
        ui.scopeOptions.forEach((option, index) => option.setAttribute('aria-pressed', String(enabled === Boolean(index))));
        ui.rule.textContent = enabled
            ? 'Одежда, обувь, сумки и украшения. Только то, что видно на фото.'
            : 'Без обуви и аксессуаров. Исключения можно добавить в пожелании.';
        ui.prompt.textContent = enabled ? ACCESSORIES_PROMPT : SYSTEM_PROMPT;
    };
    for (const [enabled, label, symbol] of [[false, 'Только одежда', 'shirt'], [true, 'С аксессуарами', 'glasses']]) {
        const option = button('', () => {
            settings().includeAccessories = enabled;
            saveSettings();
            updateScope();
        });
        option.append(icon(symbol), node('span', '', label));
        ui.scopeOptions.push(option);
        scope.append(option);
    }
    updateScope();
    ui.comment = node('textarea', 'pc-input');
    ui.comment.rows = 2;
    ui.comment.maxLength = 4000;
    ui.comment.placeholder = 'Например: добавь очки, только девушка слева…';
    const comment = node('details', 'pc-comment');
    comment.append(node('summary', '', 'Добавить пожелание'), field('Дополнительный комментарий', ui.comment));
    outfit.append(pinterest, upload, profileRow, scope, ui.rule, comment);

    const preferences = ui.panels.settings;
    preferences.append(node('h3', '', 'Настройки'), sendbarToggle());
    preferences.append(node('p', 'pc-hint', 'Выбирай профиль Chat Completion с vision-моделью. Фото и пожелание отправятся через него, отдельно от чата.'));
    const help = node('details', 'pc-advanced');
    help.append(node('summary', '', 'Как добавить картинку'), node('p', 'pc-hint', 'Поиск открывает Pinterest в другой вкладке или окне. Скачай фото, вернись сюда и нажми «Добавить фото». Если Pinterest не открылся, разреши всплывающие окна для Таверны. Можно также перетащить файл или вставить изображение из буфера. JPG, PNG, WebP, GIF · до 25 МБ.'));
    const advanced = node('details', 'pc-advanced');
    advanced.append(node('summary', '', 'Промпт и лимит ответа'));
    ui.tokens = node('input', 'pc-input');
    ui.tokens.type = 'number';
    ui.tokens.min = '256';
    ui.tokens.max = '8192';
    ui.tokens.step = '256';
    const savedTokens = Number(settings().maxTokens);
    ui.tokens.value = String(Number.isFinite(savedTokens) ? Math.min(8192, Math.max(256, savedTokens)) : 2048);
    ui.tokens.addEventListener('change', () => {
        ui.tokens.value = String(Math.min(8192, Math.max(256, Number(ui.tokens.value) || 2048)));
        settings().maxTokens = Number(ui.tokens.value);
        saveSettings();
    });
    advanced.append(field('Лимит токенов (включая рассуждения модели)', ui.tokens), ui.prompt);
    preferences.append(help, advanced);
    ui.generate = button('Описать одежду', generate);
    ui.generate.classList.add('pc-primary');
    ui.cancel = button('Отменить', () => activeRequest?.abort());
    ui.cancel.classList.add('pc-wide');
    ui.generateActions = node('div', 'pc-actions');
    ui.generateActions.append(ui.generate, ui.cancel);

    const output = ui.panels.result;
    ui.resultEmpty = node('div', 'pc-empty');
    ui.resultEmpty.append(icon('spark'), node('h3', '', 'Здесь будет описание'), node('p', 'pc-hint', 'Добавь фото во вкладке «Образ» и нажми «Описать одежду».'));
    ui.result = node('textarea', 'pc-input pc-result');
    ui.result.rows = 7;
    ui.result.placeholder = 'clothes: …';
    ui.result.addEventListener('input', syncButtons);
    ui.copy = iconButton('Копировать', 'copy', copyResult);
    ui.insert = button('Вставить и скопировать', insertResult);
    ui.insert.classList.add('pc-primary');
    ui.outputActions = node('div', 'pc-actions');
    ui.outputActions.append(ui.copy, ui.insert);
    output.append(ui.resultEmpty, field('Описание (можно исправить)', ui.result));
    ui.status = node('p', 'pc-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    ui.cropEditor = createCropEditor({
        onCancel: cancelCrop,
        onApply(value, rect) {
            if (value !== image) ui.result.value = '';
            image = value;
            cropRect = rect;
            ui.preview.src = image;
            showView('outfit');
            ui.crop.focus({ preventScroll: true });
            status('Фото готово. Модель получит область из рамки.');
        },
    });
    ui.panels.crop = ui.cropEditor.element;
    ui.body.append(ui.cropEditor.element);
    const footer = node('footer', 'pc-footer');
    footer.append(ui.status, ui.generateActions, ui.outputActions, ui.cropEditor.actions);
    dialog.append(header, tabs, ui.body, footer);
    showView('outfit');
    dialog.addEventListener('paste', event => {
        const item = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/'));
        if (item && !activeRequest) { event.preventDefault(); void loadImage(item.getAsFile()); }
    });
    dialog.addEventListener('close', () => {
        activeRequest?.abort();
        if (ui.view === 'crop') showView('outfit');
        returnFocus?.focus();
    });
    dialog.addEventListener('cancel', event => {
        if (ui.view === 'crop') { event.preventDefault(); cancelCrop(); }
    });
    document.body.append(dialog);
    const fitViewport = () => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        dialog.style.setProperty('--pc-viewport-height', `${viewport.height}px`);
        dialog.style.setProperty('--pc-viewport-top', `${viewport.offsetTop}px`);
    };
    window.visualViewport?.addEventListener('resize', fitViewport);
    window.visualViewport?.addEventListener('scroll', fitViewport);
    fitViewport();
}

function open() {
    if (!dialog) createDialog();
    if (dialog.open) return;
    returnFocus = document.activeElement;
    if (!activeRequest) refreshProfiles();
    dialog.showModal();
}

function syncSendbar() {
    const enabled = settings().showSendbar === true;
    let shortcut = document.getElementById('pinclothes-sendbar');
    const optionsButton = document.getElementById('options_button');
    const container = document.getElementById('leftSendForm') || document.getElementById('rightSendForm');
    if (enabled && !shortcut && (optionsButton || container)) {
        shortcut = button('', open);
        shortcut.id = 'pinclothes-sendbar';
        shortcut.className = 'pc-sendbar interactable';
        shortcut.title = 'Pinterest';
        shortcut.setAttribute('aria-label', 'Pinterest');
        shortcut.setAttribute('aria-haspopup', 'dialog');
        const mark = node('span', 'pc-pinterest-icon');
        mark.setAttribute('aria-hidden', 'true');
        shortcut.append(mark);
        if (optionsButton) optionsButton.before(shortcut);
        else container.append(shortcut);
    }
    if (!enabled) shortcut?.remove();
    document.querySelectorAll('.pc-sendbar-toggle').forEach(input => { input.checked = enabled; });
}

function sendbarToggle() {
    const label = node('label', 'pc-toggle');
    const input = node('input', 'pc-sendbar-toggle');
    input.type = 'checkbox';
    input.checked = settings().showSendbar === true;
    input.addEventListener('change', () => {
        settings().showSendbar = input.checked;
        saveSettings();
        syncSendbar();
    });
    label.append(input, node('span', '', 'Иконка в строке ввода'));
    return label;
}

function init() {
    syncSendbar();
    if (document.getElementById('pinclothes-wand')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const entry = node('div', 'list-group-item flex-container flexGap5 interactable');
    entry.id = 'pinclothes-wand';
    entry.tabIndex = 0;
    entry.setAttribute('role', 'button');
    const mark = node('span', 'extensionsMenuExtensionButton pc-pinterest-icon');
    mark.setAttribute('aria-hidden', 'true');
    entry.append(mark, node('span', '', 'Pinterest'));
    entry.addEventListener('click', () => { menu.style.display = 'none'; open(); });
    entry.addEventListener('keydown', event => {
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); entry.click(); }
    });
    menu.append(entry);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
const ctx = context();
if (ctx.eventSource && ctx.eventTypes?.APP_READY) ctx.eventSource.on(ctx.eventTypes.APP_READY, init);
