import { describe, errorMessage, getProfiles, SYSTEM_PROMPT } from './api.js';

const KEY = 'pinClothes';
const context = () => SillyTavern.getContext();
let dialog;
let image = '';
let originalFile;
let imageVersion = 0;
let loadingImage = false;
let activeRequest;
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
    const element = node('button', 'menu_button pc-button', text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
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
    ui.tokens.disabled = busy;
    ui.file.disabled = busy;
    ui.clear.disabled = busy || loadingImage || !image;
    ui.download.disabled = !originalFile;
    ui.copy.disabled = !ui.result.value.trim();
    ui.insert.disabled = !ui.result.value.trim();
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
    if (!file || activeRequest) return;
    const version = ++imageVersion;
    loadingImage = true;
    status('Подготавливаю изображение…');
    syncButtons();
    try {
        const prepared = await prepareImage(file);
        if (version !== imageVersion) return;
        image = prepared;
        originalFile = file;
        ui.preview.src = image;
        ui.preview.hidden = false;
        ui.placeholder.hidden = true;
        ui.filename.textContent = file.name || 'Изображение из буфера';
        ui.result.value = '';
        status('Изображение готово. Выбери профиль и нажми «Описать одежду».');
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

function openPinterest() {
    const query = ui.search.value.trim();
    const url = query ? `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}` : 'https://www.pinterest.com/';
    // A real browsing window supports login and downloads; Pinterest blocks iframes.
    window.open(url, '_blank', 'popup,width=1100,height=850,noopener,noreferrer');
    status('Pinterest открыт в окне или вкладке. Скачай картинку и прикрепи её здесь. Если окно не появилось, разреши всплывающие окна для Таверны.');
}

async function generate() {
    if (activeRequest || loadingImage || !image) return;
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
            maxTokens: Number(ui.tokens.value),
            signal: controller.signal,
        });
        ui.result.value = result;
        status('Готово. Можно отредактировать, скопировать или вставить в сообщение.');
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

async function copyResult() {
    try {
        await navigator.clipboard.writeText(ui.result.value);
        status('Описание скопировано.');
    } catch {
        ui.result.focus();
        ui.result.select();
        if (document.execCommand('copy')) status('Описание скопировано.');
        else status('Текст выделен — скопируй его вручную.', true);
    }
}

function insertResult() {
    const input = document.getElementById('send_textarea');
    if (!input || input.disabled) return status('Поле сообщения сейчас недоступно.', true);
    const text = ui.result.value.trim();
    if (!text) return;
    input.value = `${input.value}${input.value && !input.value.endsWith('\n') ? '\n' : ''}${text}`;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    dialog.close();
    input.focus();
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
    const title = node('h2', '', 'PinClothes');
    title.id = 'pc-title';
    header.append(title, button('Закрыть', () => dialog.close()));
    const body = node('div', 'pc-body');
    const pinterest = node('section', 'pc-card');
    pinterest.append(node('h3', '', '1. Найти в Pinterest'));
    ui = {};
    ui.search = node('input', 'text_pole');
    ui.search.placeholder = 'Например: leopard print outfit';
    ui.search.type = 'search';
    ui.search.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); openPinterest(); }
    });
    pinterest.append(field('Поиск (необязательно)', ui.search), button('Открыть Pinterest ↗', openPinterest));
    pinterest.append(node('p', 'pc-hint', 'Pinterest откроется отдельным окном, на телефоне — возможно вкладкой. Сайт запрещает встраивание. Скачай нужную картинку и вернись сюда.'));

    const columns = node('div', 'pc-columns');
    const upload = node('section', 'pc-card');
    upload.append(node('h3', '', '2. Прикрепить изображение'));
    const drop = node('div', 'pc-drop');
    drop.tabIndex = 0;
    drop.setAttribute('aria-label', 'Область для перетаскивания или вставки изображения');
    ui.placeholder = node('p', 'pc-hint', 'Перетащи картинку сюда или вставь из буфера (Ctrl+V / ⌘V).');
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
    ui.file.accept = 'image/jpeg,image/png,image/webp,image/gif';
    ui.file.addEventListener('change', () => void loadImage(ui.file.files[0]));
    ui.filename = node('div', 'pc-hint pc-filename');
    ui.clear = button('Убрать', clearImage);
    ui.download = button('Скачать оригинал', downloadImage);
    const imageActions = node('div', 'pc-actions');
    imageActions.append(ui.clear, ui.download);
    upload.append(drop, field('Выбрать файл', ui.file), ui.filename, imageActions);
    upload.append(node('p', 'pc-hint', 'JPG, PNG, WebP, GIF · до 25 МБ. Для модели: JPEG до 2048 px; для GIF — первый кадр.'));

    const analysis = node('section', 'pc-card');
    analysis.append(node('h3', '', '3. Описать одежду'));
    ui.profile = node('select', 'text_pole');
    ui.profile.addEventListener('change', () => {
        settings().profileId = ui.profile.value;
        saveSettings();
        syncButtons();
    });
    ui.refresh = button('Обновить профили', refreshProfiles);
    analysis.append(field('Профиль подключения', ui.profile), ui.refresh);
    analysis.append(node('p', 'pc-hint', 'Нужен профиль Chat Completion с поддержкой изображений (vision). Картинка и комментарий отправляются выбранной модели.'));
    ui.comment = node('textarea', 'text_pole');
    ui.comment.rows = 3;
    ui.comment.maxLength = 4000;
    ui.comment.placeholder = 'Например: опиши также очки. Или: только одежду девушки слева.';
    analysis.append(field('Дополнительный комментарий', ui.comment));
    analysis.append(node('p', 'pc-hint', 'По умолчанию — только одежда. Обувь, сумки, очки, украшения, резинки, бутылки и прочие предметы исключены. Чтобы включить что-то из этого, прямо назови предмет в комментарии.'));
    const advanced = node('details', 'pc-advanced');
    advanced.append(node('summary', '', 'Промпт и лимит ответа'));
    ui.tokens = node('input', 'text_pole');
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
    advanced.append(field('Лимит токенов (включая рассуждения модели)', ui.tokens), node('pre', 'pc-prompt', SYSTEM_PROMPT));
    analysis.append(advanced);
    ui.generate = button('Описать одежду', generate);
    ui.generate.classList.add('pc-primary');
    ui.cancel = button('Отменить', () => activeRequest?.abort());
    const actions = node('div', 'pc-actions');
    actions.append(ui.generate, ui.cancel);
    analysis.append(actions);
    columns.append(upload, analysis);

    const output = node('section', 'pc-card');
    ui.result = node('textarea', 'text_pole pc-result');
    ui.result.rows = 4;
    ui.result.placeholder = 'clothes: brown leopard-print halter top (ruched, tie-neck, backless), baggy low-rise light-wash denim jeans';
    ui.result.addEventListener('input', syncButtons);
    ui.copy = button('Копировать', copyResult);
    ui.insert = button('Вставить в сообщение', insertResult);
    const outputActions = node('div', 'pc-actions');
    outputActions.append(ui.copy, ui.insert);
    output.append(field('Описание (можно исправить)', ui.result), outputActions);
    ui.status = node('p', 'pc-status');
    ui.status.setAttribute('role', 'status');
    ui.status.setAttribute('aria-live', 'polite');
    body.append(pinterest, columns, output, ui.status);
    dialog.append(header, body);
    dialog.addEventListener('paste', event => {
        const item = Array.from(event.clipboardData?.items || []).find(item => item.type.startsWith('image/'));
        if (item && !activeRequest) { event.preventDefault(); void loadImage(item.getAsFile()); }
    });
    dialog.addEventListener('close', () => {
        activeRequest?.abort();
        returnFocus?.focus();
    });
    document.body.append(dialog);
}

function open() {
    if (!dialog) createDialog();
    if (dialog.open) return;
    returnFocus = document.activeElement;
    if (!activeRequest) refreshProfiles();
    dialog.showModal();
}

function init() {
    if (document.getElementById('pinclothes-wand')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const entry = node('div', 'list-group-item flex-container flexGap5 interactable');
    entry.id = 'pinclothes-wand';
    entry.tabIndex = 0;
    entry.setAttribute('role', 'button');
    const icon = node('span', 'extensionsMenuExtensionButton fa-solid fa-shirt');
    icon.setAttribute('aria-hidden', 'true');
    entry.append(icon, node('span', '', 'Pinterest · Описать одежду'));
    entry.addEventListener('click', () => { menu.style.display = 'none'; open(); });
    entry.addEventListener('keydown', event => {
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); entry.click(); }
    });
    menu.append(entry);
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (container) {
        const panel = node('div', 'pc-settings');
        panel.append(button('PinClothes — Pinterest и описание одежды', open));
        container.append(panel);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
const ctx = context();
if (ctx.eventSource && ctx.eventTypes?.APP_READY) ctx.eventSource.on(ctx.eventTypes.APP_READY, init);
