import { errorMessage, isPortrait } from './api.js';
import { createTagEditor, normalizeTags } from './tags.js';

const DATABASE = 'pinClothes-wardrobe';
const STORE = 'items';
const METADATA = 'metadata';
const PAGE_SIZE = 12;

function metadata(item) {
    return { id: item.id, mode: item.mode, tags: normalizeTags(item.tags), chatKey: item.chat?.key || null };
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 2);
        let blocked = false;
        request.onupgradeneeded = () => {
            const db = request.result;
            const store = db.objectStoreNames.contains(STORE)
                ? request.transaction.objectStore(STORE)
                : db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
            const meta = db.createObjectStore(METADATA, { keyPath: 'id' });
            const cursor = store.openCursor();
            cursor.onsuccess = () => {
                if (!cursor.result) return;
                meta.put(metadata(cursor.result.value));
                cursor.result.continue();
            };
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            blocked = true;
            reject(new Error('Хранилище занято другой вкладкой. Закрой её и попробуй снова.'));
        };
        request.onsuccess = () => {
            if (blocked) request.result.close();
            else {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            }
        };
    });
}

async function transaction(mode, run) {
    const db = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE, METADATA], mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить изменения в шкафу.'));
            tx.onerror = () => {}; // The abort event reports transaction failures.
            run(tx.objectStore(STORE), value => { result = value; }, tx.objectStore(METADATA));
        });
    } finally {
        db.close();
    }
}

async function thumbnail(source) {
    const picture = new Image();
    const canvas = document.createElement('canvas');
    try {
        picture.src = source;
        await picture.decode();
        const scale = Math.min(1, 480 / Math.max(picture.naturalWidth, picture.naturalHeight));
        canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
        canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.78));
        if (!blob) throw new Error('Не удалось создать миниатюру.');
        return blob;
    } finally {
        picture.removeAttribute('src');
        canvas.width = canvas.height = 0;
    }
}

export async function saveOutfit(source, description, name, tags = [], chat = null, mode = 'caption') {
    const preview = !source && isPortrait(mode) ? null : await thumbnail(source);
    return transaction('readwrite', (store, done, meta) => {
        const item = { preview, description, name, mode, tags: normalizeTags(tags), chat, createdAt: Date.now() };
        const request = store.add(item);
        request.onsuccess = () => {
            meta.put(metadata({ ...item, id: request.result }));
            done(request.result);
        };
    });
}

function readPage(before, chatKey, selectedTags, direction, dossier) {
    return transaction('readonly', (store, done, meta) => {
        const ids = [];
        const tags = new Map();
        let more = false;
        const request = meta.openCursor(null, direction);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                const items = new Array(ids.length);
                ids.forEach((id, index) => {
                    store.get(id).onsuccess = event => { items[index] = event.target.result; };
                });
                done({ items, more, tags: [...tags.values()] });
                return;
            }
            const item = cursor.value;
            if (isPortrait(item.mode) === dossier && (chatKey === null || item.chatKey === chatKey)) {
                const keys = item.tags.map(tag => tag.toLocaleLowerCase('ru'));
                item.tags.forEach((tag, index) => { if (!tags.has(keys[index])) tags.set(keys[index], tag); });
                const afterBoundary = before == null || (direction === 'prev' ? item.id < before : item.id > before);
                if (afterBoundary && selectedTags.every(tag => keys.includes(tag))) {
                    if (ids.length < PAGE_SIZE) ids.push(item.id);
                    else more = true;
                }
            }
            cursor.continue();
        };
    });
}

export function createWardrobe({ node, button, iconButton, copyText, getChat }) {
    const element = node('div', 'pc-wardrobe');
    const message = node('p', 'pc-hint');
    message.setAttribute('role', 'status');
    const list = node('div', 'pc-wardrobe-list');
    const navigation = node('div', 'pc-wardrobe-navigation');
    const pageLabel = node('span', 'pc-hint');
    let visible = false;
    let version = 0;
    let boundaries = [undefined];
    let nextBoundary;
    let urls = [];
    let chat = null;
    let local = false;
    const selectedTags = new Map();
    const controls = node('div', 'pc-wardrobe-controls');
    let dossier = false;
    const sections = node('div', 'pc-wardrobe-sections');
    sections.setAttribute('role', 'group');
    sections.setAttribute('aria-label', 'Раздел шкафа');
    for (const [label, value] of [['Одежда', false], ['Досье', true]]) {
        const option = button(label, () => {
            dossier = value;
            for (const tab of sections.children) tab.setAttribute('aria-pressed', String(tab === option));
            changeScope(local);
        });
        option.setAttribute('aria-pressed', String(!value));
        sections.append(option);
    }
    const scopes = node('div', 'pc-wardrobe-scopes');
    scopes.setAttribute('role', 'group');
    scopes.setAttribute('aria-label', 'Коллекция');
    const all = button('Все образы', () => changeScope(false));
    const currentChat = button('Этот чат', () => changeScope(true));
    scopes.append(all, currentChat);
    const toolbar = node('div', 'pc-wardrobe-toolbar');
    const sort = node('select', 'pc-input');
    sort.setAttribute('aria-label', 'Порядок образов');
    sort.append(new Option('Новые', 'prev'), new Option('Старые', 'next'));
    sort.addEventListener('change', () => resetPage());
    toolbar.append(scopes, sort);
    const filters = node('div', 'pc-tag-presets pc-wardrobe-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Фильтр по тегам');
    const clearTags = button('Все теги', () => {
        selectedTags.clear();
        resetPage();
    });
    filters.title = 'Образы со всеми выбранными тегами';
    controls.append(sections, toolbar, filters);

    function resetPage() {
        boundaries = [undefined];
        void load();
    }

    function changeScope(value) {
        local = value && Boolean(chat);
        selectedTags.clear();
        all.textContent = dossier ? 'Все досье' : 'Все образы';
        all.setAttribute('aria-pressed', String(!local));
        currentChat.setAttribute('aria-pressed', String(local));
        currentChat.hidden = !chat;
        currentChat.title = chat ? `Чат: ${chat.name}` : '';
        resetPage();
    }

    function renderFilters(tags) {
        const available = new Map(tags.map(tag => [tag.toLocaleLowerCase('ru'), tag]));
        for (const [key, tag] of selectedTags) available.set(key, tag);
        clearTags.setAttribute('aria-pressed', String(!selectedTags.size));
        filters.replaceChildren(clearTags);
        for (const [key, tag] of [...available].sort((a, b) => a[1].localeCompare(b[1], 'ru'))) {
            const filter = button(tag, () => {
                if (selectedTags.has(key)) selectedTags.delete(key);
                else selectedTags.set(key, tag);
                resetPage();
            });
            filter.setAttribute('aria-pressed', String(selectedTags.has(key)));
            filters.append(filter);
        }
    }

    const previous = button('Назад', () => {
        if (boundaries.length < 2) return;
        boundaries.pop();
        void load();
    });
    const next = button('Дальше', () => {
        if (nextBoundary == null) return;
        boundaries.push(nextBoundary);
        void load();
    });
    const retry = button('Повторить загрузку', () => void load());
    retry.hidden = true;
    navigation.append(previous, pageLabel, next);
    element.append(controls, message, retry, list, navigation);

    function release() {
        list.replaceChildren();
        for (const url of urls) URL.revokeObjectURL(url);
        urls = [];
    }

    async function load() {
        if (!visible) return;
        const current = ++version;
        release();
        nextBoundary = undefined;
        previous.disabled = next.disabled = true;
        retry.hidden = true;
        message.classList.remove('pc-error');
        message.textContent = 'Открываю шкаф…';
        list.setAttribute('aria-busy', 'true');
        try {
            const { items, more, tags } = await readPage(boundaries.at(-1), local ? chat.key : null, [...selectedTags.keys()], sort.value, dossier);
            if (!visible || current !== version) return;
            renderFilters(tags);
            filters.hidden = dossier;
            if (!items.length && boundaries.length > 1) {
                boundaries.pop();
                void load();
                return;
            }
            message.textContent = items.length ? '' : selectedTags.size ? 'Нет образов с выбранными тегами.' : local ? 'В этом чате пока нет образов. Все сохранённые доступны в «Все образы».' : 'Шкаф пока пуст. Добавь фото во вкладке «Образ» и получи описание.';
            pageLabel.textContent = `Стр. ${boundaries.length}`;
            if (dossier && !items.length) message.textContent = local ? 'В этом чате пока нет досье.' : 'Здесь появятся сохранённые описания ботов и персон.';
            navigation.hidden = !items.length;
            previous.disabled = boundaries.length === 1;
            next.disabled = !more;
            nextBoundary = more ? items.at(-1).id : undefined;
            for (const item of items) {
                const card = node('article', 'pc-wardrobe-card');
                const cover = node('div', 'pc-card-cover');
                if (item.preview) {
                    const image = node('img', 'pc-wardrobe-image');
                    image.alt = item.name || 'Сохранённый образ';
                    image.loading = 'lazy';
                    image.decoding = 'async';
                    const url = URL.createObjectURL(item.preview);
                    urls.push(url);
                    image.src = url;
                    cover.append(image);
                } else {
                    const glyph = node('span', `fa-solid fa-${item.mode === 'bot' ? 'robot' : 'address-card'}`);
                    glyph.setAttribute('aria-hidden', 'true');
                    cover.append(glyph);
                }
                if (item.mode === 'tags') cover.append(node('span', 'pc-nai-badge', 'NAI'));
                const content = node('div', 'pc-wardrobe-content');
                if (dossier) content.append(node('strong', '', `${item.mode === 'bot' ? 'Бот' : 'Персона'} · ${item.name}`));
                const tags = node('div', 'pc-wardrobe-tags');
                const renderTags = () => {
                    tags.replaceChildren(...(item.tags || []).map(tag => node('span', 'pc-wardrobe-badge', tag)));
                    tags.hidden = !tags.childElementCount;
                };
                renderTags();
                const description = node('p', 'pc-wardrobe-description', item.description);
                const editorPanel = node('div', 'pc-card-tag-editor');
                editorPanel.hidden = true;
                let editor;
                const edit = button('Теги', () => {
                    if (!editor) {
                        editor = createTagEditor({ node, button }, item.tags || []);
                        const save = button('Сохранить теги', async () => {
                            const values = editor.getTags();
                            save.disabled = true;
                            editor.setDisabled(true);
                            try {
                                await transaction('readwrite', (store, done, meta) => {
                                    const request = store.get(item.id);
                                    request.onsuccess = () => {
                                        // A card deleted in another tab must not be resurrected.
                                        if (request.result) {
                                            const updated = { ...request.result, tags: values };
                                            store.put(updated);
                                            meta.put(metadata(updated));
                                        }
                                    };
                                });
                                if (!visible || current !== version) return;
                                item.tags = values;
                                renderTags();
                                editorPanel.hidden = true;
                                edit.setAttribute('aria-expanded', 'false');
                                message.textContent = 'Теги сохранены.';
                                message.classList.remove('pc-error');
                                edit.focus({ preventScroll: true });
                                await load();
                                if (visible && current + 1 === version) message.textContent = 'Теги сохранены.';
                            } catch (error) {
                                if (!visible || current !== version) return;
                                message.textContent = `Не удалось сохранить теги: ${errorMessage(error)}`;
                                message.classList.add('pc-error');
                            } finally {
                                save.disabled = false;
                                editor.setDisabled(false);
                            }
                        });
                        editorPanel.append(editor.element, save);
                    }
                    editorPanel.hidden = !editorPanel.hidden;
                    edit.setAttribute('aria-expanded', String(!editorPanel.hidden));
                });
                edit.setAttribute('aria-expanded', 'false');
                const actions = node('div', 'pc-actions');
                const copy = button('Копировать', async () => {
                    const copied = await copyText(item.description);
                    if (!visible || current !== version) return;
                    message.textContent = copied ? 'Описание скопировано.' : 'Не удалось скопировать. Выдели текст карточки вручную.';
                    message.classList.toggle('pc-error', !copied);
                });
                const remove = iconButton(dossier ? 'Удалить досье' : 'Удалить образ', 'trash', async () => {
                    remove.disabled = true;
                    try {
                        await transaction('readwrite', (store, done, meta) => {
                            store.delete(item.id);
                            meta.delete(item.id);
                        });
                        if (visible && current === version) void load();
                    } catch (error) {
                        if (!visible || current !== version) return;
                        remove.disabled = false;
                        message.textContent = errorMessage(error);
                        message.classList.add('pc-error');
                    }
                });
                actions.append(copy, edit, remove);
                edit.hidden = dossier;
                content.append(tags, description, actions);
                card.append(cover, content);
                card.append(editorPanel);
                list.append(card);
            }
        } catch (error) {
            if (!visible || current !== version) return;
            message.textContent = `Не удалось открыть шкаф: ${errorMessage(error)}`;
            message.classList.add('pc-error');
            retry.hidden = false;
            navigation.hidden = true;
        } finally {
            if (current === version) list.setAttribute('aria-busy', 'false');
        }
    }

    return {
        element,
        open() {
            visible = true;
            chat = getChat();
            changeScope(Boolean(chat));
        },
        close() {
            visible = false;
            version++;
            release();
        },
    };
}
