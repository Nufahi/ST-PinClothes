"""Run with Python 3 + playwright and an installed Chromium.

Uses a mocked SillyTavern context; no real model request or API key needed.
Optional CHROMIUM_PATH selects an existing browser executable.
"""
import base64
import functools
import http.server
import os
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = b'''<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="/style.css"></head><body>
<div id="extensionsMenu"></div><div id="extensions_settings2"></div>
<form id="send_form"><div id="leftSendForm" style="display:flex;font-size:24px"><div id="options_button">Menu</div></div><textarea id="send_textarea">Existing draft</textarea></form>
<script>
window.calls = [];
window.mode = 'success';
window.saved = 0;
window.ctx = {
    extensionSettings: { pinClothes: JSON.parse(localStorage.getItem('pinClothes') || 'null'), disabledExtensions: [], connectionManager: {
        selectedProfile: 'main', profiles: [
            { id: 'vision', name: 'Vision', model: 'test-model', mode: 'cc' },
            { id: 'main', name: 'Main chat', mode: 'cc' },
            { id: 'text', name: 'Text only', mode: 'tc' }
        ]
    } },
    saveSettingsDebounced() { window.saved++; localStorage.setItem('pinClothes', JSON.stringify(ctx.extensionSettings.pinClothes)); },
    eventTypes: { APP_READY: 'ready' },
    eventSource: { on(_event, callback) { window.appReady = callback; } },
    ConnectionManagerRequestService: {
        getSupportedProfiles() { return ctx.extensionSettings.connectionManager.profiles; },
        async sendRequest(id, messages, tokens, options) {
            calls.push({ id, messages, tokens, stream: options.stream });
            if (mode === 'wait') {
                await new Promise((resolve, reject) => options.signal.addEventListener('abort',
                    () => reject(options.signal.reason), { once: true }));
            }
            if (mode === 'error') throw new Error('API request failed', { cause: new Error('Vision unavailable') });
            if (mode === 'empty') return { content: '', reasoning: 'Hidden reasoning' };
            return { content: 'clothes: brown halter top, light-wash jeans', reasoning: 'Hidden reasoning' };
        }
    }
};
window.SillyTavern = { getContext: () => ctx };
window.open = (...args) => { window.opened = args; return null; };
</script><script type="module" src="/index.js"></script></body></html>'''


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(FIXTURE)
        else:
            super().do_GET()

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'))
        page = browser.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        page.context.grant_permissions(['clipboard-read', 'clipboard-write'])
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        page.locator('#pinclothes-wand').click()
        assert page.locator('#pinclothes-wand > span:last-child').inner_text() == 'Pinterest'
        assert page.locator('dialog').evaluate('(d) => d.open')
        assert page.locator('select option').count() == 3  # placeholder + two CC profiles
        assert page.get_by_role('button', name='Описать одежду', exact=True).is_disabled()
        # Opening never summons the keyboard. Enable the shortcut from inside the dialog.
        assert page.evaluate('document.activeElement.tagName') == 'BUTTON'
        page.get_by_role('button', name='Настройки Pinterest', exact=True).click()
        page.locator('dialog').get_by_label('Иконка в строке ввода').check()
        assert page.locator('#leftSendForm #pinclothes-sendbar').count() == 1
        assert page.locator('#pinclothes-sendbar + #options_button').count() == 1
        page.evaluate('appReady(); appReady()')
        assert page.locator('#pinclothes-sendbar').count() == 1
        assert page.locator('#extensions_settings2').inner_html() == ''
        page.get_by_role('tab', name='Образ', exact=True).click()
        page.get_by_label('Поиск в Pinterest').fill('leopard & denim')
        page.get_by_role('button', name='Открыть Pinterest').click()
        assert page.evaluate('opened[0]') == 'https://www.pinterest.com/search/pins/?q=leopard%20%26%20denim'
        assert 'noopener' in page.evaluate('opened[2]')

        # Decode/re-encode a real local image in Chromium.
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDusAAAAASUVORK5CYII=')
        with page.expect_file_chooser() as chooser:
            page.get_by_role('button', name='Выбрать фото', exact=True).tap()
        chooser.value.set_files({'name': 'outfit.png', 'mimeType': 'image/png', 'buffer': png})
        page.wait_for_function('document.querySelector(".pc-preview").src.startsWith("data:image/jpeg;base64,")')
        page.get_by_role('button', name='Отмена', exact=True).click()
        page.get_by_label('Профиль подключения', exact=True).select_option('vision')
        page.get_by_text('Добавить пожелание', exact=True).click()
        page.get_by_label('Дополнительный комментарий').fill('Опиши также очки')
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-result").value.startsWith("clothes:")')
        assert page.get_by_role('tab', name='Результат', exact=True).get_attribute('aria-selected') == 'true'
        request = page.evaluate('calls[0]')
        assert 'DEFAULT SCOPE: clothing garments only' in request['messages'][0]['content']
        assert request['id'] == 'vision' and request['stream'] is False
        assert len(request['messages']) == 2
        assert request['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,')
        assert 'Опиши также очки' in request['messages'][1]['content'][0]['text']
        assert 'Existing draft' not in str(request)
        assert page.evaluate('ctx.extensionSettings.connectionManager.selectedProfile') == 'main'
        assert 'Hidden reasoning' not in page.locator('.pc-result').input_value()

        page.get_by_role('button', name='Вставить и скопировать').click()
        page.wait_for_function('!document.querySelector("dialog").open')
        assert page.locator('#send_textarea').input_value() == 'Existing draft\nclothes: brown halter top, light-wash jeans'
        assert page.evaluate('navigator.clipboard.readText()') == 'clothes: brown halter top, light-wash jeans'
        page.locator('#pinclothes-sendbar').tap()
        page.get_by_role('tab', name='Образ', exact=True).click()
        assert page.locator('select').input_value() == 'vision'

        # Crop a two-color image with a real touch drag; only the blue half reaches the model.
        crop_png = page.evaluate('''() => {
            const c = document.createElement('canvas'); c.width = 400; c.height = 300;
            const p = c.getContext('2d'); p.fillStyle = '#ff0000'; p.fillRect(0, 0, 200, 300);
            p.fillStyle = '#0000ff'; p.fillRect(200, 0, 200, 300);
            return c.toDataURL().split(',')[1];
        }''')
        page.locator('.pc-file').set_input_files({'name': 'crop.png', 'mimeType': 'image/png', 'buffer': base64.b64decode(crop_png)})
        page.get_by_role('button', name='Применить', exact=True).wait_for()
        page.wait_for_function('document.querySelector(".pc-crop-image").complete && document.querySelector(".pc-crop-area").clientWidth > 100')
        original = page.locator('.pc-preview').get_attribute('src')
        bounds = page.locator('.pc-crop-area').bounding_box()
        handle = page.get_by_role('button', name='Верхний левый угол').bounding_box()
        x, y = handle['x'] + 10, handle['y'] + 10
        session = page.context.new_cdp_session(page)
        session.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        session.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + bounds['width'] / 2, 'y': y + bounds['height'] / 4}]})
        session.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        page.get_by_role('button', name='Применить', exact=True).click()
        cropped = page.locator('.pc-preview').get_attribute('src')
        assert cropped != original
        pixels = page.evaluate('''async (src) => {
            const img = new Image(); img.src = src; await img.decode();
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const p = c.getContext('2d'); p.drawImage(img, 0, 0);
            return { w: img.width, h: img.height, rgb: Array.from(p.getImageData(20, 20, 1, 1).data) };
        }''', cropped)
        assert pixels['w'] == 200 and pixels['h'] == 225, pixels
        assert pixels['rgb'][0] < 15 and pixels['rgb'][2] > 240, pixels
        # Reopening uses the full source and retains the selection; cancel/reset are non-destructive.
        page.get_by_role('button', name='Обрезать фото', exact=True).click()
        assert page.locator('.pc-crop-image').get_attribute('src') == original
        page.get_by_role('button', name='Полное фото', exact=True).click()
        page.get_by_role('button', name='Отмена', exact=True).click()
        assert page.locator('.pc-preview').get_attribute('src') == cropped
        page.get_by_role('button', name='Обрезать фото', exact=True).click()
        selection = page.locator('.pc-crop-selection')
        previous_left = selection.evaluate('(e) => parseFloat(e.style.left)')
        selection.press('ArrowLeft')
        assert selection.evaluate('(e) => parseFloat(e.style.left)') < previous_left
        page.get_by_role('button', name='Верхний левый угол').press('ArrowRight')
        page.keyboard.press('Escape')
        assert page.locator('dialog').evaluate('(d) => d.open')
        assert page.locator('.pc-preview').get_attribute('src') == cropped
        page.get_by_role('button', name='С аксессуарами', exact=True).click()
        page.get_by_label('Дополнительный комментарий').fill('без сумки')
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-result").value.startsWith("clothes:")')
        request = page.evaluate('calls.at(-1)')
        assert request['messages'][1]['content'][1]['image_url']['url'] == cropped
        assert 'visible clothing together with visible footwear and wearable accessories' in request['messages'][0]['content']
        assert 'DEFAULT SCOPE' not in request['messages'][0]['content']
        assert 'без сумки' in request['messages'][1]['content'][0]['text']
        page.get_by_role('tab', name='Образ', exact=True).click()
        # Restoring the full photo invalidates the old description.
        page.get_by_role('button', name='Обрезать фото', exact=True).click()
        page.get_by_role('button', name='Полное фото', exact=True).click()
        page.get_by_role('button', name='Применить', exact=True).click()
        assert page.locator('.pc-preview').get_attribute('src') == original
        assert page.locator('.pc-result').input_value() == ''
        # Crop layout stays bounded on phones, landscape, and desktop.
        page.get_by_role('button', name='Обрезать фото', exact=True).click()
        for width, height in [(320, 568), (844, 390), (390, 420), (1200, 900)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(100)
            assert page.locator('.pc-body').evaluate('(d) => d.scrollWidth <= d.clientWidth')
            assert page.locator('.pc-footer').evaluate('(d) => d.getBoundingClientRect().bottom <= visualViewport.height + 1')
        page.get_by_role('button', name='Закрыть', exact=True).click()
        page.locator('#pinclothes-sendbar').click()
        assert page.get_by_role('tab', name='Образ', exact=True).is_visible()
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-result").value.startsWith("clothes:")')
        page.get_by_role('tab', name='Образ', exact=True).click()

        # Provider errors are visible without losing the previous editable result.
        page.evaluate("mode = 'error'")
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-status").textContent.includes("Vision unavailable")')
        page.evaluate("mode = 'empty'")
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-status").textContent.includes("пустой ответ")')

        # Cancellation and closing both abort only the side request.
        page.evaluate("mode = 'wait'")
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        assert page.get_by_role('button', name='Только одежда', exact=True).is_disabled()
        assert page.get_by_role('button', name='Обрезать фото', exact=True).is_disabled()
        page.get_by_role('tab', name='Результат', exact=True).click()
        page.get_by_role('button', name='Отменить', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-status").textContent === "Запрос отменён."')
        page.get_by_role('tab', name='Образ', exact=True).click()
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.get_by_role('button', name='Закрыть', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-status").textContent === "Запрос отменён."')
        page.locator('#pinclothes-sendbar').tap()
        assert page.get_by_role('button', name='С аксессуарами', exact=True).get_attribute('aria-pressed') == 'true'
        page.get_by_role('button', name='Только одежда', exact=True).click()

        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.locator('.pc-dialog').evaluate('(d) => d.getBoundingClientRect().width <= 390')
        assert page.locator('.pc-body').evaluate('(d) => d.scrollWidth <= d.clientWidth')

        # Missing profiles fail closed rather than silently switching to the chat model.
        page.evaluate('ctx.extensionSettings.connectionManager.profiles = []')
        page.get_by_role('button', name='Обновить профили').click()
        assert page.get_by_role('button', name='Описать одежду', exact=True).is_disabled()
        page.get_by_role('button', name='Убрать', exact=True).click()
        assert page.locator('.pc-preview').is_hidden()
        assert page.locator('.pc-result').input_value() == ''
        # Touch layout at narrow widths, in landscape, with a keyboard-sized viewport, and on desktop.
        for width, height in [(320, 568), (390, 844), (430, 932), (844, 390), (390, 420), (1200, 900)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(100)
            for tab in ['Образ', 'Результат']:
                page.get_by_role('tab', name=tab, exact=True).click()
                assert page.locator('.pc-body').evaluate('(d) => d.scrollWidth <= d.clientWidth')
                assert page.locator('.pc-footer').evaluate('''(d) => {
                    const r = d.getBoundingClientRect();
                    return r.top >= 0 && r.bottom <= window.visualViewport.height + 1;
                }''')
            page.get_by_role('tab', name='Образ', exact=True).click()
            assert page.get_by_role('button', name='Выбрать фото', exact=True).evaluate('(b) => b.getBoundingClientRect().height >= 140')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.get_by_role('button', name='С аксессуарами', exact=True).click()
        # Optional screenshot for visual review.
        if os.environ.get('SCREENSHOT_PATH'):
            page.screenshot(path=os.environ['SCREENSHOT_PATH'])
        page.get_by_role('button', name='Закрыть', exact=True).click()
        assert page.locator('#pinclothes-sendbar').get_attribute('type') == 'button'
        # Preference survives reload; turning it off removes the shortcut immediately.
        page.reload()
        page.locator('#pinclothes-sendbar').tap()
        assert page.get_by_role('button', name='С аксессуарами', exact=True).get_attribute('aria-pressed') == 'true'
        page.get_by_role('button', name='Только одежда', exact=True).click()
        page.get_by_role('button', name='Настройки Pinterest', exact=True).click()
        page.locator('dialog').get_by_label('Иконка в строке ввода').uncheck()
        assert page.locator('#pinclothes-sendbar').count() == 0
        page.get_by_role('button', name='Закрыть', exact=True).click()
        page.reload()
        page.locator('#pinclothes-wand').wait_for()
        assert page.locator('#pinclothes-sendbar').count() == 0
        page.locator('#pinclothes-wand').click()
        assert page.get_by_role('button', name='Только одежда', exact=True).get_attribute('aria-pressed') == 'true'
        assert not errors, errors
        browser.close()
        print('PASS: touch crop, crop pixels in request, reset/cancel, accessory prompts, touch UI, profiles, draft insertion, errors, cancellation, responsive layout, persisted settings')
finally:
    server.shutdown()
