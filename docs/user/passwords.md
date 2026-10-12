# Saved logins

On an HTTPS sign-in page, focus the username, password, or one-time code field to
see matching saved logins beside it. If Vault is locked, choose **Unlock Vault**;
focusing a field never opens an unlock prompt by itself. Press Arrow Down to enter
the suggestions, or Escape to dismiss them. The key menu beside the browser
address bar remains available too.

Choose a saved login to fill the visible sign-in fields. Conn advances an email-first step, waits
for the password field, fills it, and submits the login. It then fills the one-time
code when that field appears and submits it. This continues for up to two minutes
in the same tab and on the same site. Conn submits each filled sign-in step once.
If a form has several submit actions, use its button yourself. Choose the login again to retry a rejected
password or code.

On Mac, the menu combines matching logins from the Vault app with
test logins. Each source has its own section. If Vault is locked, choose **Unlock
Vault** and complete its Touch ID or master-password prompt. Vault matches HTTPS
sites and checks the selected login again before filling. These personal Vault
logins are available through the user's browser menu; agents cannot list them.

Check Vault's status in **Settings → Passwords → Password manager**. Vault runs on
the Mac hosting the browser, including when the thread uses a remote environment.
Personal Vault passwords stay local to that Mac; the environment receives only
the fill result.

The separate **Vaultwarden · this Mac** connection selects the dedicated account
and collection intended for Conn-managed credentials. Connecting it does not
copy your personal Vault passwords into that collection.
