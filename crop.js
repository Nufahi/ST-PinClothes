// Normalized coordinates keep the selection stable when the phone rotates.
export function createCropEditor({ onApply, onCancel }) {
    const element = document.createElement('section');
    element.className = 'pc-panel pc-crop';
    element.innerHTML = `
        <h3>Обрезать фото</h3>
        <p class="pc-hint">Двигай рамку и тяни за углы. Модель увидит только область внутри.</p>
        <div class="pc-crop-stage">
            <div class="pc-crop-area">
                <img class="pc-crop-image" alt="Фото для обрезки" draggable="false">
                <div class="pc-crop-selection" tabindex="0" role="group" aria-label="Область обрезки" aria-describedby="pc-crop-keyboard">
                    <span class="pc-crop-grid" aria-hidden="true"></span>
                </div>
            </div>
        </div>
        <div class="pc-crop-info"><output class="pc-hint" aria-live="polite"></output></div>
        <p class="pc-hint" id="pc-crop-keyboard">С клавиатуры: стрелки двигают рамку, стрелки на углах меняют размер. Shift — быстрее.</p>`;
    const stage = element.querySelector('.pc-crop-stage');
    const area = element.querySelector('.pc-crop-area');
    const img = element.querySelector('img');
    const selection = element.querySelector('.pc-crop-selection');
    const size = element.querySelector('output');
    const actions = document.createElement('div');
    actions.className = 'pc-actions';
    const makeButton = (text, callback, className = '') => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `pc-button ${className}`;
        button.textContent = text;
        button.addEventListener('click', callback);
        return button;
    };
    let source = '';
    let rect = { x: 0, y: 0, w: 1, h: 1 };
    let drag;
    let ready = false;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const pixels = () => {
        const x = Math.min(img.naturalWidth - 1, Math.round(rect.x * img.naturalWidth));
        const y = Math.min(img.naturalHeight - 1, Math.round(rect.y * img.naturalHeight));
        return { x, y,
            w: Math.max(1, Math.round((rect.x + rect.w) * img.naturalWidth) - x),
            h: Math.max(1, Math.round((rect.y + rect.h) * img.naturalHeight) - y) };
    };
    function render() {
        if (!ready) return;
        const scale = Math.min((stage.clientWidth - 32) / img.naturalWidth, (stage.clientHeight - 32) / img.naturalHeight);
        area.style.width = `${Math.max(1, img.naturalWidth * scale)}px`;
        area.style.height = `${Math.max(1, img.naturalHeight * scale)}px`;
        Object.assign(selection.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
        const p = pixels();
        size.textContent = `${p.w} × ${p.h} px`;
    }
    function change(start, corner, dx, dy) {
        if (!corner) {
            rect = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
        } else {
            const bounds = area.getBoundingClientRect();
            const minW = Math.min(start.w, 48 / bounds.width);
            const minH = Math.min(start.h, 48 / bounds.height);
            let left = start.x, top = start.y, right = left + start.w, bottom = top + start.h;
            if (corner.includes('w')) left = clamp(left + dx, 0, right - minW);
            if (corner.includes('e')) right = clamp(right + dx, left + minW, 1);
            if (corner.includes('n')) top = clamp(top + dy, 0, bottom - minH);
            if (corner.includes('s')) bottom = clamp(bottom + dy, top + minH, 1);
            rect = { x: left, y: top, w: right - left, h: bottom - top };
        }
        render();
    }
    for (const [corner, label] of [['nw', 'Верхний левый угол'], ['ne', 'Верхний правый угол'], ['sw', 'Нижний левый угол'], ['se', 'Нижний правый угол']]) {
        const handle = makeButton('', () => {}, 'pc-crop-handle');
        handle.dataset.corner = corner;
        handle.setAttribute('aria-label', label);
        selection.append(handle);
    }
    selection.addEventListener('pointerdown', event => {
        if (!ready || drag || !event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        const target = event.target.closest('[data-corner]') || selection;
        target.focus({ preventScroll: true });
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, rect: { ...rect }, corner: target.dataset.corner, bounds: area.getBoundingClientRect() };
        selection.setPointerCapture(event.pointerId);
    });
    selection.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        change(drag.rect, drag.corner, (event.clientX - drag.x) / drag.bounds.width, (event.clientY - drag.y) / drag.bounds.height);
    });
    const endDrag = () => { drag = undefined; };
    selection.addEventListener('pointerup', endDrag);
    selection.addEventListener('pointercancel', endDrag);
    selection.addEventListener('lostpointercapture', endDrag);
    selection.addEventListener('keydown', event => {
        if (!ready || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.05 : 0.01;
        change(rect, event.target.dataset.corner,
            event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
            event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
    });
    const reset = makeButton('Полное фото', () => { rect = { x: 0, y: 0, w: 1, h: 1 }; render(); });
    element.querySelector('.pc-crop-info').append(reset);
    const apply = makeButton('Применить', () => {
        if (!ready) return;
        try {
            const p = pixels();
            let result = source;
            if (p.x || p.y || p.w !== img.naturalWidth || p.h !== img.naturalHeight) {
                const canvas = document.createElement('canvas');
                canvas.width = p.w;
                canvas.height = p.h;
                canvas.getContext('2d').drawImage(img, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
                result = canvas.toDataURL('image/jpeg', 0.9);
            }
            onApply(result, { ...rect });
        } catch {
            size.textContent = 'Не удалось обрезать фото. Попробуй ещё раз.';
        }
    }, 'pc-primary');
    actions.append(makeButton('Отмена', onCancel), apply);
    img.addEventListener('load', () => { ready = true; apply.disabled = false; render(); });
    img.addEventListener('error', () => { ready = false; apply.disabled = true; size.textContent = 'Не удалось открыть фото.'; });
    new ResizeObserver(() => { endDrag(); render(); }).observe(stage);
    return {
        element, actions,
        open(value, savedRect) {
            endDrag();
            source = value;
            rect = savedRect ? { ...savedRect } : { x: 0, y: 0, w: 1, h: 1 };
            ready = false;
            apply.disabled = true;
            size.textContent = 'Подготовка…';
            img.src = source;
        },
    };
}
