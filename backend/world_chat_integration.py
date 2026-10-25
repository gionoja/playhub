# ADDITIVE INTEGRATION LINES FOR backend/app.py
# Add alongside the existing imports:
from world_chat import world_chat_bp

# Add alongside the existing app.register_blueprint(...) calls,
# before the db.create_all() application-context block:
app.register_blueprint(world_chat_bp)
