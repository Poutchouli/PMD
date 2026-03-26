"""
Fonctions utilitaires partagées pour le backend PMD.
"""

import ipaddress
import socket


def resolve_host(value: str) -> str:
    """Resolve a hostname or IP string to a normalised IP address.

    Accepts IPv4, IPv6 or a domain name.  Domain names are resolved via
    ``socket.getaddrinfo`` (preferring IPv4).  Returns the normalised IP
    string or raises ``ValueError`` on failure.
    """
    value = value.strip()
    if not value:
        raise ValueError("empty host")

    # Fast-path: already a valid IP literal
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass

    # Attempt DNS resolution
    try:
        results = socket.getaddrinfo(value, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError(f"Cannot resolve hostname: {value}")

    if not results:
        raise ValueError(f"Cannot resolve hostname: {value}")

    # Prefer IPv4 if available
    for family, *_rest in results:
        if family == socket.AF_INET:
            return results[[r[0] for r in results].index(socket.AF_INET)][4][0]

    # Fallback to first result (likely IPv6)
    return results[0][4][0]


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
