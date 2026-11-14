import { errorMessage } from './api.js';
import { createTagEditor, normalizeTags } from './tags.js';

const DATABASE = 'pinClothes-wardrobe';
const STORE = 'items';
const PAGE_SIZE = 12;

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        let blocked = false;
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            blocked = true;
            reject(new Error('Хранилище занято другой вкладкой. Закрой её и попробуй снова.'));
        };
        request.onsuccess = () => {
            if (blocked) request.result.close();
            else resolve(request.result);
        };
    });
}

async function transaction(mode, run) {
    const db = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить изменения в шкафу.'));
            tx.onerror = () => {}; // The abort event reports transaction failures.
            run(tx.objectStore(STORE), value => { result = value; });
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

export async function saveOutfit(source, description, name, tags = []) {
    const preview = await thumbnail(source);
    return transaction('readwrite', (store, done) => {
        const request = store.add({ preview, description, name, tags: normalizeTags(tags), createdAt: Date.now() });
        request.onsuccess = () => done(request.result);
    });
}

function readPage(before) {
    return transaction('readonly', (store, done) => {
        const items = [];
        const range = before == null ? null : IDBKeyRange.upperBound(before, true);
        const request = store.openCursor(range, 'prev');
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || items.length === PAGE_SIZE) {
                done({ items, more: Boolean(cursor) });
                return;
            }
            items.push(cursor.value);
            cursor.continue();
        };
    });
}

export function createWardrobe({ node, button, iconButton, copyText }) {
    const element = node('div', 'pc-wardrobe');
    const hint = node('p', 'pc-hint', 'Образы добавляются после описания, если включено «Добавлять в шкаф». Коллекция хранится только в этом браузере.');
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
    element.append(hint, message, retry, list, navigation);

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
            const { items, more } = await readPage(boundaries.at(-1));
            if (!visible || current !== version) return;
            if (!items.length && boundaries.length > 1) {
                boundaries.pop();
                void load();
                return;
            }
            message.textContent = items.length ? '' : 'Шкаф пока пуст. Добавь фото во вкладке «Образ» и получи описание.';
            pageLabel.textContent = `Стр. ${boundaries.length}`;
            navigation.hidden = !items.length;
            previous.disabled = boundaries.length === 1;
            next.disabled = !more;
            nextBoundary = more ? items.at(-1).id : undefined;
            for (const item of items) {
                const card = node('article', 'pc-wardrobe-card');
                const image = node('img', 'pc-wardrobe-image');
                image.alt = item.name || 'Сохранённый образ';
                image.loading = 'lazy';
                image.decoding = 'async';
                const url = URL.createObjectURL(item.preview);
                urls.push(url);
                image.src = url;
                const content = node('div', 'pc-wardrobe-content');
                const badge = node('span', 'pc-wardrobe-badge', 'Образ');
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
                                await transaction('readwrite', store => {
                                    const request = store.get(item.id);
                                    request.onsuccess = () => {
                                        // A card deleted in another tab must not be resurrected.
                                        if (request.result) store.put({ ...request.result, tags: values });
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
                const remove = iconButton('Удалить образ', 'trash', async () => {
                    remove.disabled = true;
                    try {
                        await transaction('readwrite', store => store.delete(item.id));
                        if (visible && current === version) void load();
                    } catch (error) {
                        if (!visible || current !== version) return;
                        remove.disabled = false;
                        message.textContent = errorMessage(error);
                        message.classList.add('pc-error');
                    }
                });
                actions.append(copy, edit, remove);
                content.append(badge, tags, description, actions);
                card.append(image, content);
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
            boundaries = [undefined];
            void load();
        },
        close() {
            visible = false;
            version++;
            release();
        },
    };
}
