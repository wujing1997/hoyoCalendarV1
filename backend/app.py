import io
import os
import sys
from datetime import date

from flask import Flask, jsonify, request

from agent_service import AgentService
from config_store import ConfigStore


if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer,
        encoding='utf-8',
        errors='replace',
    )
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(
        sys.stderr.buffer,
        encoding='utf-8',
        errors='replace',
    )


DATA_DIR = os.path.join(
    os.environ.get('APPDATA', os.path.expanduser('~')),
    'HoyoCalendar',
)
VERSION = os.environ.get('HOYO_CALENDAR_VERSION', '3.0.8')

config_store = ConfigStore(DATA_DIR)
agent_service = AgentService(config_store)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024
app.json.ensure_ascii = False


@app.after_request
def set_local_headers(response):
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.route('/api/health', methods=['GET'])
def health():
    settings = config_store.ai_settings()
    return jsonify({
        'status': 'ready',
        'version': VERSION,
        'configured': config_store.is_ai_configured(),
        'provider': settings['provider'],
    })


@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify(config_store.load())


@app.route('/api/config', methods=['PUT'])
def update_config():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'success': False, 'message': '配置格式无效'}), 400
    saved = config_store.save(payload)
    return jsonify({'success': True, 'config': saved})


def handle_agent_chat():
    payload = request.get_json(silent=True) or {}
    message = str(payload.get('message') or '').strip()
    if not message:
        return jsonify({'message': '请输入日程指令。', 'actions': []}), 400
    session_id = str(payload.get('session_id') or 'main')[:80]
    events = payload.get('events') if isinstance(payload.get('events'), list) else []
    today = str(payload.get('today') or date.today().strftime('%Y-%m-%d'))
    try:
        result = agent_service.chat(message, session_id, events, today)
        return jsonify(result)
    except Exception as error:
        app.logger.exception('Agent request failed')
        return jsonify({
            'message': 'AI 请求失败，请检查模型配置或稍后再试。',
            'actions': [],
            'error': type(error).__name__,
        }), 502


@app.route('/api/agent/chat', methods=['POST'])
def agent_chat():
    return handle_agent_chat()


@app.route('/api/chat', methods=['POST'])
def legacy_chat():
    return handle_agent_chat()


def handle_reset():
    payload = request.get_json(silent=True) or {}
    session_id = str(payload.get('session_id') or 'main')[:80]
    agent_service.reset(session_id)
    return jsonify({'success': True})


@app.route('/api/agent/reset', methods=['POST'])
def agent_reset():
    return handle_reset()


@app.route('/api/chat/reset', methods=['POST'])
def legacy_chat_reset():
    return handle_reset()


@app.errorhandler(404)
def not_found(_error):
    return jsonify({'message': 'Not found'}), 404


@app.errorhandler(413)
def payload_too_large(_error):
    return jsonify({'message': '请求内容过大'}), 413


if __name__ == '__main__':
    port = 5000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    print(f'HoYoCalendar V{VERSION} agent backend listening on 127.0.0.1:{port}', flush=True)
    app.run(
        host='127.0.0.1',
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )
