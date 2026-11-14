const PRESETS = ['Женское', 'Мужское', 'Унисекс', 'Повседневное', 'Деловое', 'Вечернее', 'Спортивное', 'Летнее', 'Зимнее'];

function suggestions() {
    return normalizeTags([...PRESETS, ...(SillyTavern.getContext().extensionSettings.pinClothes?.customTags || [])]);
}

function rememberTags(tags) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings.pinClothes ??= {};
    const presetKeys = PRESETS.map(tag => tag.toLocaleLowerCase('ru'));
    const saved = normalizeTags([...(settings.customTags || []), ...tags])
        .filter(tag => !presetKeys.includes(tag.toLocaleLowerCase('ru')));
    if (JSON.stringify(saved) === JSON.stringify(settings.customTags || [])) return;
    settings.customTags = saved;
    context.saveSettingsDebounced();
}

export function normalizeTags(values = []) {
    const tags = new Map();
    for (const value of values) {
        const tag = value.trim().replace(/\s+/g, ' ');
        const key = tag.toLocaleLowerCase('ru');
        if (tag && !tags.has(key)) tags.set(key, tag);
    }
    return [...tags.values()];
}

export function createTagEditor({ node, button }, values = []) {
    const element = node('div', 'pc-tag-editor');
    const presets = node('div', 'pc-tag-presets');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Готовые теги');
    let options = [];
    let disabled = false;
    const label = node('label', 'pc-field');
    const custom = node('input', 'pc-input');
    custom.type = 'text';
    custom.maxLength = 500;
    custom.placeholder = 'Например: свидание, любимое';
    label.append(node('span', '', 'Свои теги через запятую'), custom);
    element.append(presets, label);

    function getTags() {
        return normalizeTags([
            ...options.filter(option => option.getAttribute('aria-pressed') === 'true').map(option => option.textContent),
            ...custom.value.split(','),
        ]);
    }

    function acceptCustom() {
        if (!custom.value.trim()) return;
        setTags(getTags());
    }
    custom.addEventListener('change', () => rememberTags(getTags()));
    custom.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            acceptCustom();
        }
    });

    function setTags(tags) {
        const normalized = normalizeTags(tags);
        rememberTags(normalized);
        const keys = normalized.map(tag => tag.toLocaleLowerCase('ru'));
        options = suggestions().map(tag => {
            const option = button(tag, () => {
                option.setAttribute('aria-pressed', String(option.getAttribute('aria-pressed') !== 'true'));
            });
            option.setAttribute('aria-pressed', String(keys.includes(tag.toLocaleLowerCase('ru'))));
            option.disabled = disabled;
            return option;
        });
        presets.replaceChildren(...options);
        custom.value = '';
    }
    setTags(values);

    return {
        element,
        setTags,
        getTags() {
            const tags = getTags();
            setTags(tags);
            return tags;
        },
        setDisabled(value) {
            disabled = value;
            custom.disabled = disabled;
            options.forEach(option => { option.disabled = disabled; });
        },
    };
}
