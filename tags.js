const PRESETS = ['Женское', 'Мужское', 'Унисекс', 'Повседневное', 'Деловое', 'Вечернее', 'Спортивное', 'Летнее', 'Зимнее'];

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
    const options = PRESETS.map(tag => {
        const option = button(tag, () => {
            option.setAttribute('aria-pressed', String(option.getAttribute('aria-pressed') !== 'true'));
        });
        option.setAttribute('aria-pressed', 'false');
        presets.append(option);
        return option;
    });
    const label = node('label', 'pc-field');
    const custom = node('input', 'pc-input');
    custom.type = 'text';
    custom.maxLength = 500;
    custom.placeholder = 'Например: свидание, любимое';
    label.append(node('span', '', 'Свои теги через запятую'), custom);
    element.append(presets, label);

    function setTags(tags) {
        const normalized = normalizeTags(tags);
        const keys = normalized.map(tag => tag.toLocaleLowerCase('ru'));
        options.forEach((option, index) => {
            option.setAttribute('aria-pressed', String(keys.includes(PRESETS[index].toLocaleLowerCase('ru'))));
        });
        custom.value = normalized.filter(tag => !PRESETS.some(preset => preset.toLocaleLowerCase('ru') === tag.toLocaleLowerCase('ru'))).join(', ');
    }
    setTags(values);

    return {
        element,
        setTags,
        getTags() {
            return normalizeTags([
                ...PRESETS.filter((_, index) => options[index].getAttribute('aria-pressed') === 'true'),
                ...custom.value.split(','),
            ]);
        },
        setDisabled(disabled) {
            custom.disabled = disabled;
            options.forEach(option => { option.disabled = disabled; });
        },
    };
}
