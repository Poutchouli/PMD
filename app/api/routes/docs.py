"""
Routes de documentation et changelog.
"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pathlib import Path
from typing import Optional
import re

router = APIRouter(prefix="/api/docs", tags=["Documentation"])


def get_changelog_path() -> Path:
    """Trouve le fichier CHANGELOG.md."""
    docker_path = Path("/app/CHANGELOG.md")
    if docker_path.exists():
        return docker_path
    local_path = Path(__file__).parent.parent.parent.parent / "CHANGELOG.md"
    if local_path.exists():
        return local_path
    alt_path = Path(__file__).parent.parent.parent / "CHANGELOG.md"
    if alt_path.exists():
        return alt_path
    return docker_path


CHANGELOG_PATH = get_changelog_path()


def parse_changelog_versions() -> list[dict]:
    if not CHANGELOG_PATH.exists():
        return []
    content = CHANGELOG_PATH.read_text(encoding="utf-8")
    pattern = r"## \[(\d+\.\d+\.\d+)\] - (.+?)(?:\n|$)"
    matches = re.findall(pattern, content)
    return [{"version": v, "date": d.strip()} for v, d in matches]


def extract_version_content(version: str) -> Optional[str]:
    if not CHANGELOG_PATH.exists():
        return None
    content = CHANGELOG_PATH.read_text(encoding="utf-8")
    start_pattern = rf"## \[{re.escape(version)}\] - .+?\n"
    start_match = re.search(start_pattern, content)
    if not start_match:
        return None
    next_match = re.search(r"\n## \[\d+\.\d+\.\d+\] - ", content[start_match.end():])
    if next_match:
        end_pos = start_match.end() + next_match.start()
    else:
        format_match = re.search(r"\n---\n\n## Format du changelog", content[start_match.end():])
        end_pos = start_match.end() + format_match.start() if format_match else len(content)
    return content[start_match.start():end_pos].strip()


@router.get("/changelog", response_class=PlainTextResponse)
async def get_changelog(
    since: Optional[str] = Query(None, description="Voir les changements depuis cette version"),
    latest: bool = Query(False, description="Uniquement la dernière version"),
):
    if not CHANGELOG_PATH.exists():
        raise HTTPException(status_code=404, detail="Changelog non trouvé")
    content = CHANGELOG_PATH.read_text(encoding="utf-8")
    if latest:
        versions = parse_changelog_versions()
        if versions:
            version_content = extract_version_content(versions[0]["version"])
            if version_content:
                return version_content
    if since:
        versions = parse_changelog_versions()
        version_numbers = [v["version"] for v in versions]
        if since in version_numbers:
            since_index = version_numbers.index(since)
            newer_versions = version_numbers[:since_index]
            if not newer_versions:
                return f"Aucun changement depuis la version {since}"
            result_parts = [f"# Changements depuis la version {since}\n"]
            for v in newer_versions:
                v_content = extract_version_content(v)
                if v_content:
                    result_parts.append(v_content)
                    result_parts.append("\n---\n")
            return "\n".join(result_parts)
    return content


@router.get("/changelog/versions")
async def get_changelog_versions():
    versions = parse_changelog_versions()
    return {
        "total_versions": len(versions),
        "latest_version": versions[0]["version"] if versions else None,
        "versions": versions,
    }


@router.get("/changelog/diff")
async def get_changelog_diff(
    from_version: str = Query(..., description="Version de départ"),
    to_version: Optional[str] = Query(None, description="Version d'arrivée (défaut: dernière)"),
):
    versions = parse_changelog_versions()
    version_numbers = [v["version"] for v in versions]
    if from_version not in version_numbers:
        raise HTTPException(status_code=404, detail=f"Version {from_version} non trouvée")
    if to_version and to_version not in version_numbers:
        raise HTTPException(status_code=404, detail=f"Version {to_version} non trouvée")
    to_version = to_version or (versions[0]["version"] if versions else None)
    from_index = version_numbers.index(from_version)
    to_index = version_numbers.index(to_version)
    if from_index <= to_index:
        return {
            "from_version": from_version,
            "to_version": to_version,
            "changes": [],
            "message": "Aucun changement - version cible identique ou antérieure",
        }
    versions_between = version_numbers[to_index:from_index]
    changes = []
    for v in versions_between:
        content = extract_version_content(v)
        v_info = next((ver for ver in versions if ver["version"] == v), None)
        changes.append({
            "version": v,
            "date": v_info["date"] if v_info else None,
            "content": content,
        })
    return {
        "from_version": from_version,
        "to_version": to_version,
        "total_changes": len(changes),
        "changes": changes,
    }
