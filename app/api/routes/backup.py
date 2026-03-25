"""
Routes pour le système de backup/restore de PMD.
Découvre et sauvegarde automatiquement TOUTES les tables de la base de données.

Note: La table ping_logs est exclue par défaut (hypertable TimescaleDB volumineuse).
"""
import json
import base64
import zipfile
import io
import uuid
import hashlib
from datetime import datetime, date, timezone
from typing import Any, Dict, List
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import logging

from app.config import get_settings, APP_VERSION
from app.db import get_db
from app.hub_auth import require_role, TokenPayload
from app.hub_client import hub_client
from app.schemas import BackupMetadata, SyncToHubRequest, SyncFromHubRequest, MessageResponse
from app.storage import storage_manager
from app.utils import human_readable_size, human_readable_duration

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/api/admin", tags=["Backup/Restore"])

BYTES_PER_ROW_AVG = 400
BYTES_PER_SECOND_ESTIMATE = 10 * 1024 * 1024

# Tables à exclure du backup
EXCLUDED_TABLES = {
    "alembic_version",
    "spatial_ref_sys",
    "ping_logs",       # Hypertable TimescaleDB — trop volumineux
}


def _compute_checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    elif isinstance(value, datetime):
        return {"__type__": "datetime", "value": value.isoformat()}
    elif isinstance(value, date):
        return {"__type__": "date", "value": value.isoformat()}
    elif isinstance(value, Decimal):
        return {"__type__": "decimal", "value": str(value)}
    elif isinstance(value, bytes):
        return {"__type__": "bytes", "value": base64.b64encode(value).decode("ascii")}
    elif isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    elif isinstance(value, dict):
        return {k: _serialize_value(v) for k, v in value.items()}
    return value


def _deserialize_value(value: Any) -> Any:
    if value is None:
        return None
    elif isinstance(value, dict):
        if "__type__" in value:
            t = value["__type__"]
            raw = value["value"]
            if t == "datetime":
                return datetime.fromisoformat(raw)
            elif t == "date":
                return date.fromisoformat(raw)
            elif t == "decimal":
                return Decimal(raw)
            elif t == "bytes":
                return base64.b64decode(raw)
        return {k: _deserialize_value(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [_deserialize_value(v) for v in value]
    return value


async def _get_all_tables(db: AsyncSession) -> List[str]:
    result = await db.execute(text("""
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
    """))
    tables = [row[0] for row in result.fetchall()]
    return [t for t in tables if t not in EXCLUDED_TABLES]


async def _get_table_row_count(db: AsyncSession, table_name: str) -> int:
    result = await db.execute(text(f'SELECT COUNT(*) FROM "{table_name}"'))
    return result.scalar() or 0


async def _get_table_columns(db: AsyncSession, table_name: str) -> List[Dict[str, str]]:
    result = await db.execute(text("""
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = :table_name
        ORDER BY ordinal_position
    """), {"table_name": table_name})
    return [
        {"name": row[0], "type": row[1], "nullable": row[2] == "YES", "default": row[3]}
        for row in result.fetchall()
    ]


async def _get_primary_key_columns(db: AsyncSession, table_name: str) -> List[str]:
    result = await db.execute(text("""
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = (SELECT oid FROM pg_class WHERE relname = :table_name AND relnamespace = 'public'::regnamespace)
          AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
    """), {"table_name": table_name})
    return [row[0] for row in result.fetchall()]


async def _export_table_data(db: AsyncSession, table_name: str) -> List[Dict[str, Any]]:
    columns_info = await _get_table_columns(db, table_name)
    column_names = [c["name"] for c in columns_info]
    result = await db.execute(text(f'SELECT * FROM "{table_name}"'))
    rows = result.fetchall()
    data = []
    for row in rows:
        row_dict = {}
        for i, col_name in enumerate(column_names):
            row_dict[col_name] = _serialize_value(row[i])
        data.append(row_dict)
    return data


async def _import_table_data(
    db: AsyncSession,
    table_name: str,
    data: List[Dict[str, Any]],
    clear_existing: bool = False,
) -> Dict[str, int]:
    stats = {"imported": 0, "updated": 0, "skipped": 0, "errors": 0}
    if not data:
        return stats
    pk_columns = await _get_primary_key_columns(db, table_name)
    columns_info = await _get_table_columns(db, table_name)
    existing_columns = {c["name"] for c in columns_info}

    if clear_existing:
        await db.execute(text(f'DELETE FROM "{table_name}"'))

    for row_data in data:
        try:
            deserialized = {k: _deserialize_value(v) for k, v in row_data.items()}
            filtered_data = {k: v for k, v in deserialized.items() if k in existing_columns}
            if not filtered_data:
                stats["skipped"] += 1
                continue
            columns = list(filtered_data.keys())
            placeholders = [f":{col}" for col in columns]

            if pk_columns and not clear_existing:
                update_cols = [c for c in columns if c not in pk_columns]
                if update_cols:
                    update_set = ", ".join([f'"{col}" = EXCLUDED."{col}"' for col in update_cols])
                    query = f"""
                        INSERT INTO "{table_name}" ({", ".join([f'"{c}"' for c in columns])})
                        VALUES ({", ".join(placeholders)})
                        ON CONFLICT ({", ".join([f'"{c}"' for c in pk_columns])})
                        DO UPDATE SET {update_set}
                    """
                else:
                    query = f"""
                        INSERT INTO "{table_name}" ({", ".join([f'"{c}"' for c in columns])})
                        VALUES ({", ".join(placeholders)})
                        ON CONFLICT ({", ".join([f'"{c}"' for c in pk_columns])})
                        DO NOTHING
                    """
            else:
                query = f"""
                    INSERT INTO "{table_name}" ({", ".join([f'"{c}"' for c in columns])})
                    VALUES ({", ".join(placeholders)})
                """
            await db.execute(text(query), filtered_data)
            stats["imported"] += 1
        except Exception as e:
            logger.warning("⚠️ Erreur import ligne dans %s: %s", table_name, e)
            stats["errors"] += 1
    return stats


# ============================================================
# ESTIMATION
# ============================================================

@router.get("/backup/estimate")
async def estimate_backup(
    db: AsyncSession = Depends(get_db),
    user: TokenPayload = Depends(require_role("admin")),
):
    tables = await _get_all_tables(db)
    tables_stats = {}
    total_rows = 0
    for table_name in tables:
        count = await _get_table_row_count(db, table_name)
        tables_stats[table_name] = count
        total_rows += count

    db_size = total_rows * BYTES_PER_ROW_AVG
    storage_stats = await storage_manager.get_storage_stats()
    files_size = storage_stats.get("total_size", 0)
    total_size = int((db_size + files_size) * 1.1)
    duration = total_size / BYTES_PER_SECOND_ESTIMATE

    warning = None
    if total_size > 100 * 1024 * 1024:
        warning = "Backup volumineux détecté."
    if total_size > 1024 * 1024 * 1024:
        warning = "⚠️ Backup très volumineux (> 1 GB)."

    return {
        "tables": tables_stats,
        "total_tables": len(tables),
        "total_rows": total_rows,
        "database_size_bytes": db_size,
        "files_size_bytes": files_size,
        "total_size_bytes": total_size,
        "total_size_human": human_readable_size(total_size),
        "estimated_duration_seconds": duration,
        "estimated_duration_human": human_readable_duration(duration),
        "files_by_category": storage_stats.get("by_category", {}),
        "files_by_mime_type": storage_stats.get("by_mime_type", {}),
        "warning": warning,
    }


# ============================================================
# CRÉATION DU BACKUP
# ============================================================

@router.post("/backup")
async def create_backup(
    db: AsyncSession = Depends(get_db),
    user: TokenPayload = Depends(require_role("admin")),
):
    backup_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    logger.info("📦 Création du backup %s par %s", backup_id, user.sub)

    try:
        tables = await _get_all_tables(db)
        data_export: Dict[str, Any] = {}
        table_stats: Dict[str, int] = {}

        for table_name in tables:
            try:
                table_data = await _export_table_data(db, table_name)
                data_export[table_name] = table_data
                table_stats[table_name] = len(table_data)
            except Exception as e:
                logger.warning("⚠️ Erreur export %s: %s", table_name, e)
                data_export[table_name] = []
                table_stats[table_name] = 0

        backup_data = {
            "metadata": {
                "backup_id": backup_id,
                "app_slug": settings.APP_SLUG,
                "app_version": APP_VERSION,
                "created_at": created_at,
                "created_by": user.sub,
                "format_version": "3.0",
                "tables": list(tables),
                "table_stats": table_stats,
            },
            "data": data_export,
        }

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            data_json = json.dumps(backup_data, indent=2, ensure_ascii=False)
            zf.writestr("data.json", data_json)

        zip_buffer.seek(0)
        zip_data = zip_buffer.getvalue()
        total_size = len(zip_data)
        checksum = _compute_checksum(zip_data)

        backup_filename = f"backup_{backup_id}.zip"
        await storage_manager.save_bytes(
            data=zip_data, filename=backup_filename, owner="_system", category="backups"
        )

        total_rows = sum(table_stats.values())
        logger.info(
            "✅ Backup %s créé: %d tables, %d enregistrements (%s)",
            backup_id, len(tables), total_rows, human_readable_size(total_size),
        )

        return {
            "success": True,
            "message": "Backup créé avec succès",
            "metadata": {
                "backup_id": backup_id,
                "app_slug": settings.APP_SLUG,
                "app_version": APP_VERSION,
                "created_at": created_at,
                "created_by": user.sub,
                "format_version": "3.0",
                "total_tables": len(tables),
                "total_rows": total_rows,
                "total_files": 0,
                "total_size_bytes": total_size,
                "total_size_human": human_readable_size(total_size),
                "includes_files": False,
                "checksum": checksum,
                "table_stats": table_stats,
            },
            "download_url": f"/api/admin/backup/download?backup_id={backup_id}",
        }
    except Exception as e:
        logger.error("❌ Erreur création backup: %s", e)
        raise HTTPException(status_code=500, detail=f"Erreur lors de la création du backup: {e}")


# ============================================================
# TÉLÉCHARGEMENT
# ============================================================

@router.get("/backup/download")
async def download_backup(
    backup_id: str,
    user: TokenPayload = Depends(require_role("admin")),
):
    backup_filename = f"backup_{backup_id}.zip"
    backup_path = f"_system/backups/{backup_filename}"
    content = await storage_manager.read_file(backup_path)
    if not content:
        raise HTTPException(status_code=404, detail="Backup non trouvé")
    logger.info("📥 Téléchargement backup %s par %s", backup_id, user.sub)
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{settings.APP_SLUG}_backup_{backup_id}.zip"',
            "Content-Length": str(len(content)),
        },
    )


# ============================================================
# RESTAURATION
# ============================================================

@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    clear_existing: str = Form("false"),
    db: AsyncSession = Depends(get_db),
    user: TokenPayload = Depends(require_role("admin")),
):
    clear_existing_bool = clear_existing.lower() in ("true", "1", "yes", "on")
    errors: list[str] = []
    warnings: list[str] = []
    tables_restored: Dict[str, Any] = {}

    logger.info("🔄 Restauration démarrée par %s (clear=%s)", user.sub, clear_existing_bool)

    try:
        content = await file.read()
        zip_buffer = io.BytesIO(content)

        with zipfile.ZipFile(zip_buffer, "r") as zf:
            if "data.json" not in zf.namelist():
                raise HTTPException(status_code=400, detail="Fichier de backup invalide: data.json manquant")

            data_json = zf.read("data.json").decode("utf-8")
            backup_data = json.loads(data_json)
            metadata = backup_data.get("metadata", {})
            data = backup_data.get("data", {})
            format_version = metadata.get("format_version", "1.0")

            if metadata.get("app_slug") != settings.APP_SLUG:
                warnings.append(f"Le backup provient d'une application différente ({metadata.get('app_slug')})")

            backup_tables = list(data.keys())
            existing_tables = await _get_all_tables(db)

            if clear_existing_bool:
                await db.execute(text("SET CONSTRAINTS ALL DEFERRED"))
                for table_name in existing_tables:
                    if table_name in backup_tables:
                        try:
                            await db.execute(text(f'DELETE FROM "{table_name}"'))
                        except Exception as e:
                            warnings.append(f"Impossible de vider {table_name}: {e}")
                await db.flush()

            for table_name, table_data in data.items():
                if table_name not in existing_tables:
                    warnings.append(f"Table '{table_name}' du backup n'existe pas dans la base")
                    continue
                if not table_data:
                    tables_restored[table_name] = {"imported": 0, "updated": 0, "skipped": 0}
                    continue
                try:
                    result = await _import_table_data(db, table_name, table_data, clear_existing_bool)
                    tables_restored[table_name] = result
                except Exception as e:
                    errors.append(f"Table {table_name}: {e}")
                    tables_restored[table_name] = {"imported": 0, "updated": 0, "skipped": 0, "error": str(e)}

            await db.commit()

        total_imported = sum(t.get("imported", 0) for t in tables_restored.values())
        total_updated = sum(t.get("updated", 0) for t in tables_restored.values())
        total_skipped = sum(t.get("skipped", 0) for t in tables_restored.values())

        logger.info(
            "✅ Restauration terminée: %d tables, %d importés, %d mis à jour",
            len(tables_restored), total_imported, total_updated,
        )

        return {
            "success": len(errors) == 0,
            "message": "Restauration terminée" + (" avec des erreurs" if errors else " avec succès"),
            "format_version": format_version,
            "tables_restored": tables_restored,
            "total_tables": len(tables_restored),
            "total_imported": total_imported,
            "total_updated": total_updated,
            "total_skipped": total_skipped,
            "errors": errors,
            "warnings": warnings,
        }
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Le fichier uploadé n'est pas un ZIP valide")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Le fichier data.json est corrompu")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ Erreur restauration: %s", e)
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Erreur lors de la restauration: {e}")


# ============================================================
# SYNC HUB
# ============================================================

@router.post("/sync-to-hub")
async def sync_to_hub(
    request: SyncToHubRequest = None,
    db: AsyncSession = Depends(get_db),
    user: TokenPayload = Depends(require_role("admin")),
):
    if not hub_client.is_registered:
        raise HTTPException(status_code=503, detail="Application non enregistrée auprès du Hub.")
    logger.info("☁️ Sync vers le Hub initiée par %s", user.sub)
    try:
        backup_response = await create_backup(db=db, user=user)
        if not backup_response.get("success"):
            raise HTTPException(status_code=500, detail="Échec de la création du backup")
        metadata = backup_response.get("metadata", {})
        backup_id = metadata.get("backup_id")
        backup_path = f"_system/backups/backup_{backup_id}.zip"
        backup_content = await storage_manager.read_file(backup_path)
        if not backup_content:
            raise HTTPException(status_code=500, detail="Backup créé mais fichier introuvable")
        result = await hub_client.call_hub_endpoint(
            endpoint=f"/api/apps/{settings.APP_SLUG}/backup",
            method="POST",
            files={"file": (f"backup_{backup_id}.zip", backup_content, "application/zip")},
            data={
                "backup_id": backup_id,
                "app_version": metadata.get("app_version", APP_VERSION),
                "format_version": metadata.get("format_version", "3.0"),
                "total_tables": str(metadata.get("total_tables", 0)),
                "total_rows": str(metadata.get("total_rows", 0)),
                "checksum": metadata.get("checksum", ""),
                "description": request.description if request else "",
            },
            timeout=120.0,
        )
        if result and result.get("success", True) and not result.get("error"):
            logger.info("✅ Backup %s synchronisé avec le Hub", backup_id)
            return {
                "success": True,
                "message": "Backup synchronisé avec le Hub",
                "backup_id": backup_id,
                "metadata": metadata,
            }
        error_msg = result.get("error", "Erreur inconnue") if result else "Pas de réponse du Hub"
        raise HTTPException(status_code=502, detail=f"Erreur Hub: {error_msg}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ Erreur sync vers Hub: %s", e)
        raise HTTPException(status_code=500, detail=f"Erreur de synchronisation: {e}")


@router.post("/sync-from-hub")
async def sync_from_hub(
    request: SyncFromHubRequest = None,
    db: AsyncSession = Depends(get_db),
    user: TokenPayload = Depends(require_role("admin")),
):
    if not hub_client.is_registered:
        raise HTTPException(status_code=503, detail="Application non enregistrée auprès du Hub.")
    backup_id = request.backup_id if request else None
    clear_existing = request.clear_existing if request else False
    logger.info("☁️ Restauration depuis le Hub par %s (backup_id=%s)", user.sub, backup_id)
    try:
        if not backup_id:
            latest_result = await hub_client.call_hub_endpoint(
                endpoint=f"/api/apps/{settings.APP_SLUG}/backup/latest", method="GET"
            )
            if not latest_result:
                raise HTTPException(status_code=404, detail="Aucun backup trouvé sur le Hub")
            backup_id = latest_result.get("backup_id")
            if not backup_id:
                raise HTTPException(status_code=502, detail="Le Hub n'a pas retourné d'identifiant de backup")

        result = await hub_client.call_hub_endpoint(
            endpoint=f"/api/apps/{settings.APP_SLUG}/backup/{backup_id}/restore",
            method="POST",
            data={"clear_existing": clear_existing},
            timeout=300.0,
        )
        if not result:
            raise HTTPException(status_code=502, detail="Pas de réponse du Hub")
        if result.get("error") or result.get("success") is False:
            raise HTTPException(status_code=502, detail=f"Erreur Hub: {result.get('error', result.get('message', 'Erreur'))}")
        logger.info("✅ Restauration depuis le Hub terminée")
        return {
            "success": result.get("success", True),
            "message": result.get("message", "Restauration terminée"),
            "format_version": result.get("format_version", "3.0"),
            "tables_restored": result.get("tables_restored", {}),
            "total_tables": result.get("total_tables", 0),
            "total_imported": result.get("total_imported", 0),
            "total_updated": result.get("total_updated", 0),
            "total_skipped": result.get("total_skipped", 0),
            "errors": result.get("errors", []),
            "warnings": result.get("warnings", []),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ Erreur sync depuis Hub: %s", e)
        raise HTTPException(status_code=500, detail=f"Erreur de récupération: {e}")


# ============================================================
# UTILITAIRES
# ============================================================

@router.get("/backup/list", response_model=list[BackupMetadata])
async def list_local_backups(user: TokenPayload = Depends(require_role("admin"))):
    backups = []
    files = await storage_manager.list_files(owner="_system", category="backups")
    for f in files:
        if f["filename"].startswith("backup_") and f["filename"].endswith(".zip"):
            bid = f["filename"].replace("backup_", "").replace(".zip", "")
            backups.append(BackupMetadata(
                backup_id=bid,
                app_slug=settings.APP_SLUG,
                app_version=APP_VERSION,
                created_at=f.get("modified_at", ""),
                created_by="unknown",
                total_tables=0,
                total_rows=0,
                total_size_bytes=f["size"],
                total_size_human=human_readable_size(f["size"]),
                checksum="",
            ))
    return backups


@router.delete("/backup/{backup_id}", response_model=MessageResponse)
async def delete_local_backup(
    backup_id: str,
    user: TokenPayload = Depends(require_role("admin")),
):
    backup_path = f"_system/backups/backup_{backup_id}.zip"
    deleted = await storage_manager.delete_file(backup_path)
    if deleted:
        logger.info("🗑️ Backup %s supprimé par %s", backup_id, user.sub)
        return MessageResponse(message="Backup supprimé", detail=f"ID: {backup_id}")
    raise HTTPException(status_code=404, detail="Backup non trouvé")
