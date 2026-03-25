"""
Fonctions utilitaires partagées pour le backend PMD.
"""


def human_readable_size(size: int) -> str:
    """Convertit une taille en bytes en format lisible."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} PB"


def human_readable_duration(seconds: float) -> str:
    """Convertit des secondes en format lisible."""
    if seconds < 60:
        return f"{seconds:.0f} sec"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{minutes} min {secs} sec"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return f"{hours}h {minutes} min"
