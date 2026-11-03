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
<form id="send_form"><div id="leftSendForm"></div><textarea id="send_textarea">Existing draft</textarea></form>
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
        page.evaluate('appReady(); appReady()')
        assert page.locator('#pinclothes-sendbar').count() == 1
        assert page.locator('.pc-settings').get_by_label('Иконка в строке ввода').is_checked()
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
        page.get_by_label('Профиль подключения', exact=True).select_option('vision')
        page.get_by_text('Добавить пожелание', exact=True).click()
        page.get_by_label('Дополнительный комментарий').fill('Опиши также очки')
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-result").value.startsWith("clothes:")')
        assert page.get_by_role('tab', name='Результат', exact=True).get_attribute('aria-selected') == 'true'
        request = page.evaluate('calls[0]')
        assert request['id'] == 'vision' and request['stream'] is False
        assert len(request['messages']) == 2
        assert request['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,')
        assert 'Опиши также очки' in request['messages'][1]['content'][0]['text']
        assert 'Existing draft' not in str(request)
        assert page.evaluate('ctx.extensionSettings.connectionManager.selectedProfile') == 'main'
        assert 'Hidden reasoning' not in page.locator('.pc-result').input_value()

        page.get_by_role('button', name='Вставить в сообщение').click()
        assert page.locator('#send_textarea').input_value() == 'Existing draft\nclothes: brown halter top, light-wash jeans'
        page.locator('#pinclothes-sendbar').tap()
        page.get_by_role('tab', name='Образ', exact=True).click()
        assert page.locator('select').input_value() == 'vision'

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
        page.get_by_role('tab', name='Результат', exact=True).click()
        page.get_by_role('button', name='Отменить', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-status").textContent === "Запрос отменён."')
        page.get_by_role('tab', name='Образ', exact=True).click()
        page.get_by_role('button', name='Описать одежду', exact=True).click()
        page.get_by_role('button', name='Закрыть', exact=True).click()
        page.wait_for_function('document.querySelector(".pc-status").textContent === "Запрос отменён."')
        page.locator('.pc-settings button').click()

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
        # Optional screenshot for visual review.
        if os.environ.get('SCREENSHOT_PATH'):
            page.screenshot(path=os.environ['SCREENSHOT_PATH'])
        page.get_by_role('button', name='Закрыть', exact=True).click()
        assert page.locator('#pinclothes-sendbar').get_attribute('type') == 'button'
        # Preference survives reload; turning it off removes the shortcut immediately.
        page.reload()
        page.locator('#pinclothes-sendbar').tap()
        page.get_by_role('button', name='Настройки Pinterest', exact=True).click()
        page.locator('dialog').get_by_label('Иконка в строке ввода').uncheck()
        assert page.locator('#pinclothes-sendbar').count() == 0
        page.get_by_role('button', name='Закрыть', exact=True).click()
        page.reload()
        page.locator('#pinclothes-wand').wait_for()
        assert page.locator('#pinclothes-sendbar').count() == 0
        assert not errors, errors
        browser.close()
        print('PASS: touch UI, tabs, Pinterest URL, image conversion, profile isolation, multimodal request, draft insertion, errors, cancellation, responsive layout, deleted profiles, persisted sendbar shortcut')
finally:
    server.shutdown()
