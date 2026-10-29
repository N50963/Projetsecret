#!/usr/bin/env python3
"""Lance `lidl-plus ... auth` en gardant la fenêtre du navigateur ouverte.

Le client lidl-plus ferme toujours le navigateur à la fin de la connexion (succès ou échec).
Ce script remplace uniquement cette fermeture par une attente : le navigateur reste ouvert
jusqu'à ce que vous appuyiez sur Entrée dans le terminal. Le fichier du dépôt lidl-plus
n'est pas modifié.

Usage (dans l'environnement où lidl-plus[auth] est installé) :

    python tools/lidl_auth_keep_open.py --language fr --country FR auth
"""

import sys

from selenium.common.exceptions import TimeoutException

from lidlplus import __main__ as cli
from lidlplus import browser_auth
from lidlplus.exceptions import LoginError


def run_keep_open(self):
    """Même déroulé que _BrowserLogin.run, mais attend Entrée avant de fermer le navigateur."""
    self.browser = browser_auth._create_browser(self.options.headless)  # pylint: disable=protected-access
    try:
        self.browser.get(self.login_url)
        self._fill_credentials()  # pylint: disable=protected-access
        return self._wait_for_code()  # pylint: disable=protected-access
    except TimeoutException as error:
        browser_auth._raise_login_error(self.browser)  # pylint: disable=protected-access
        raise LoginError("The Lidl login page did not reach the expected step") from error
    finally:
        input("Appuyez sur Entrée pour fermer le navigateur...")
        self.browser.quit()


browser_auth._BrowserLogin.run = run_keep_open  # pylint: disable=protected-access

if __name__ == "__main__":
    sys.exit(cli.start())
