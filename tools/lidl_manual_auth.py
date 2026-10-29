#!/usr/bin/env python3
"""Obtient un refresh token Lidl Plus après une connexion faite à la main dans votre navigateur.

Aucun navigateur n'est piloté par le script : vous vous connectez vous-même (reCAPTCHA compris),
puis vous copiez le code d'autorisation que Lidl renvoie à la fin de la connexion.

Étape 1 - affiche l'adresse de connexion et mémorise la clé PKCE :
    python tools/lidl_manual_auth.py start --country FR --language fr

Étape 2 - échange le code copié contre le token (enregistré en lecture seule pour vous) :
    python tools/lidl_manual_auth.py finish "CODE_OU_ADRESSE_COPIEE"

Seule dépendance : requests.
"""

import argparse
import base64
import hashlib
import os
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests

CLIENT_ID = "LidlPlusNativeClient"
AUTH_API = "https://accounts.lidl.com"
REDIRECT_URI = "com.lidlplus.app://callback"
SCOPE = "openid profile offline_access lpprofile lpapis"
CONFIG_DIR = Path.home() / ".config" / "lidl-plus"
VERIFIER_FILE = CONFIG_DIR / "pkce_verifier"
TOKEN_FILE = CONFIG_DIR / "refresh_token"
TIMEOUT = 15


def write_private(path, content):
    """Écrit un fichier lisible uniquement par l'utilisateur."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(content)
    path.chmod(0o600)


def build_login_url(country, language, verifier):
    """Construit l'adresse de connexion OAuth2 avec PKCE (S256)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "scope": SCOPE,
        "redirect_uri": REDIRECT_URI,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    extra = {"Country": country.upper(), "language": f"{language.lower()}-{country.upper()}"}
    return f"{AUTH_API}/connect/authorize?{urlencode(params)}&{urlencode(extra)}"


def extract_code(text):
    """Accepte le code seul ou l'adresse complète (com.lidlplus.app://callback?code=...)."""
    text = text.strip()
    if "code=" not in text and "://" not in text and "?" not in text:
        return text
    parsed = urlparse(text)
    for values in (parse_qs(parsed.query), parse_qs(parsed.fragment)):
        if values.get("code") and values["code"][0]:
            return values["code"][0]
        for key in ("redirect_uri", "returnUrl", "ReturnUrl"):
            for nested in values.get(key, []):
                nested_code = extract_code(nested) if "code=" in nested or "://" in nested else None
                if nested_code:
                    return nested_code
    raise ValueError("Aucun code trouvé dans la valeur fournie")


def exchange_code(code, verifier, session=requests):
    """Échange le code d'autorisation contre les jetons."""
    secret = base64.b64encode(f"{CLIENT_ID}:secret".encode()).decode()
    response = session.post(
        f"{AUTH_API}/connect/token",
        headers={"Authorization": f"Basic {secret}", "Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def command_start(args):
    verifier = secrets.token_urlsafe(64)
    write_private(VERIFIER_FILE, verifier)
    print("1. Ouvrez la console du navigateur (F12), onglet « Réseau »/« Network », et cochez « Conserver le journal »/« Preserve log ».")
    print("2. Ouvrez cette adresse dans ce même onglet et connectez-vous (reCAPTCHA compris) :\n")
    print(build_login_url(args.country, args.language, verifier))
    print("\n3. À la fin, une requête vers « com.lidlplus.app://callback?code=... » apparaît (souvent en rouge/annulée).")
    print("   Copiez la valeur de « code » ou l'adresse complète, puis lancez :")
    print('   python tools/lidl_manual_auth.py finish "CODE"')
    return 0


def command_finish(args):
    if not VERIFIER_FILE.is_file():
        print("Clé PKCE introuvable : relancez d'abord l'étape « start ».", file=sys.stderr)
        return 2
    try:
        code = extract_code(args.code)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    verifier = VERIFIER_FILE.read_text(encoding="utf-8").strip()
    try:
        tokens = exchange_code(code, verifier)
    except requests.HTTPError as error:
        status = error.response.status_code if error.response is not None else "?"
        print(f"Échange refusé par Lidl (HTTP {status}). Le code est à usage unique et expire vite : refaites « start ».", file=sys.stderr)
        return 1
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        print("La réponse de Lidl ne contient pas de refresh_token.", file=sys.stderr)
        return 1
    write_private(TOKEN_FILE, f"{refresh_token}\n")
    VERIFIER_FILE.unlink(missing_ok=True)
    print(f"Token enregistré dans {TOKEN_FILE}\n")
    print(refresh_token)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start", help="affiche l'adresse de connexion")
    start.add_argument("--country", default="FR")
    start.add_argument("--language", default="fr")
    finish = sub.add_parser("finish", help="échange le code copié contre le token")
    finish.add_argument("code", help="le code, ou l'adresse com.lidlplus.app://callback?code=... complète")
    args = parser.parse_args(argv)
    return command_start(args) if args.command == "start" else command_finish(args)


if __name__ == "__main__":
    sys.exit(main())
