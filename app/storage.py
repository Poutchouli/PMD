"""
Gestionnaire de stockage de fichiers pour PMD.
Permet le stockage des backups et fichiers associés.
"""
import os
import hashlib
import mimetypes
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional
from fastapi import UploadFile
import logging

from app.config import get_settings
from app.utils import human_readable_size

logger = logging.getLogger(__name__)
settings = get_settings()


class StorageManager:
    """Gestionnaire de fichiers avec structure organisée."""

    def __init__(self, base_path: Optional[str] = None):
        self.base_path = Path(base_path or settings.UPLOADS_DIR)
        self._ensure_base_path()

    def _ensure_base_path(self):
        self.base_path.mkdir(parents=True, exist_ok=True)
        logger.info("📁 Storage initialisé: %s", self.base_path)

    def _get_file_path(self, owner: str, filename: str, category: str = "general") -> Path:
        safe_owner = self._sanitize_path(owner)
        safe_category = self._sanitize_path(category)
        safe_filename = self._sanitize_filename(filename)
        dir_path = self.base_path / safe_owner / safe_category
        dir_path.mkdir(parents=True, exist_ok=True)
        return dir_path / safe_filename

    def _sanitize_path(self, name: str) -> str:
        return "".join(c for c in name if c.isalnum() or c in "-_.")[:100]

    def _sanitize_filename(self, filename: str) -> str:
        name, ext = os.path.splitext(filename)
        safe_name = "".join(c for c in name if c.isalnum() or c in "-_. ")[:200]
        safe_ext = "".join(c for c in ext if c.isalnum() or c == ".")[:10]
        return f"{safe_name}{safe_ext}"

    @staticmethod
    def compute_hash(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def get_mime_type(filename: str) -> str:
        mime_type, _ = mimetypes.guess_type(filename)
        return mime_type or "application/octet-stream"

    async def save_bytes(
        self,
        data: bytes,
        filename: str,
        owner: str,
        category: str = "general",
    ) -> dict:
        file_path = self._get_file_path(owner, filename, category)
        file_hash = self.compute_hash(data)
        with open(file_path, "wb") as f:
            f.write(data)
        relative_path = str(file_path.relative_to(self.base_path))
        return {
            "filename": filename,
            "relative_path": relative_path,
            "size": len(data),
            "hash": file_hash,
            "mime_type": self.get_mime_type(filename),
            "category": category,
            "owner": owner,
        }

    async def read_file(self, relative_path: str) -> Optional[bytes]:
        file_path = (self.base_path / relative_path).resolve()
        # Sécurité: vérifier que le chemin est dans base_path
        try:
            file_path.relative_to(self.base_path.resolve())
        except ValueError:
            logger.error("🚨 Tentative d'accès hors du storage: %s", relative_path)
            return None
        if not file_path.exists():
            return None
        with open(file_path, "rb") as f:
            return f.read()

    async def delete_file(self, relative_path: str) -> bool:
        file_path = self.base_path / relative_path
        if not file_path.exists():
            return False
        try:
            os.remove(file_path)
            logger.info("🗑️ Fichier supprimé: %s", relative_path)
            return True
        except Exception as e:
            logger.error("❌ Erreur suppression %s: %s", relative_path, e)
            return False

    async def list_files(self, owner: Optional[str] = None, category: Optional[str] = None) -> list[dict]:
        if owner:
            search_path = self.base_path / self._sanitize_path(owner)
            if category:
                search_path = search_path / self._sanitize_path(category)
        else:
            search_path = self.base_path
        if not search_path.exists():
            return []
        files = []
        for file_path in search_path.rglob("*"):
            if file_path.is_file():
                relative_path = str(file_path.relative_to(self.base_path))
                stat = file_path.stat()
                files.append({
                    "relative_path": relative_path,
                    "filename": file_path.name,
                    "size": stat.st_size,
                    "mime_type": self.get_mime_type(file_path.name),
                    "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
        return files

    async def get_storage_stats(self) -> dict:
        total_files = 0
        total_size = 0
        by_category: dict[str, int] = {}
        by_mime_type: dict[str, int] = {}
        if not self.base_path.exists():
            return {
                "total_files": 0,
                "total_size": 0,
                "total_size_human": "0 B",
                "by_category": {},
                "by_mime_type": {},
            }
        for file_path in self.base_path.rglob("*"):
            if file_path.is_file():
                total_files += 1
                size = file_path.stat().st_size
                total_size += size
                relative = file_path.relative_to(self.base_path)
                parts = relative.parts
                if len(parts) >= 2:
                    cat = parts[1]
                    by_category[cat] = by_category.get(cat, 0) + size
                mime = self.get_mime_type(file_path.name)
                by_mime_type[mime] = by_mime_type.get(mime, 0) + size
        return {
            "total_files": total_files,
            "total_size": total_size,
            "total_size_human": human_readable_size(total_size),
            "by_category": by_category,
            "by_mime_type": by_mime_type,
        }


# Instance globale
storage_manager = StorageManager()
