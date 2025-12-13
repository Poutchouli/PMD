# main.py
from app import create_app
from app.config import get_settings

app = create_app()

if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    uvicorn.run(app, host="0.0.0.0", port=settings.app_port)