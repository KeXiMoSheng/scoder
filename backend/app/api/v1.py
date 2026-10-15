"""API v1 路由。"""

from flask import Blueprint, Response, jsonify

api_v1 = Blueprint("api_v1", __name__)


@api_v1.get("/health")
def health() -> Response:
    """健康检查：供前端探活与部署编排使用。"""
    return jsonify({"status": "ok", "service": "ai-code-backend"})


@api_v1.get("/ping")
def ping() -> Response:
    return jsonify({"message": "pong"})
