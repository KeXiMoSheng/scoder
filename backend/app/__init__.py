"""Flask 应用工厂。"""

from flask import Flask
from flask_cors import CORS

from app.core.config import get_settings


def create_app() -> Flask:
    settings = get_settings()
    app = Flask(__name__)
    # 接口返回中文时不转义为 \uXXXX，便于调试阅读
    app.json.ensure_ascii = False
    # Electron 渲染进程与开发服务器均为跨域请求，统一在 /api 下放行
    CORS(app, resources={r"/api/*": {"origins": settings.cors_origins}})

    from app.api.v1 import api_v1

    app.register_blueprint(api_v1, url_prefix="/api/v1")
    return app
