//! Adapter between the GPUI-free `conn-database` crate and macOS's `conn_desktop::vault` bridge.
//!
//! Keeping this bridge in one small module ensures `conn-database` never depends on `conn-desktop`
//! and `conn-desktop` never pulls in `sqlx`.

use conn_database::api::{ConnectionSource, PanelConnection};
use conn_database::{
    CredentialFuture, DatabaseConnection, DatabaseCredentialResolver, DatabaseDriver, DatabaseSsh,
    DatabaseTls, ResolvedDatabaseCredential,
};
use conn_desktop::vault::{VaultClient, VaultDatabase, VaultDatabaseDriver, VaultTls};

fn map_driver(driver: VaultDatabaseDriver) -> DatabaseDriver {
    match driver {
        VaultDatabaseDriver::Mysql => DatabaseDriver::Mysql,
        VaultDatabaseDriver::Pgsql => DatabaseDriver::Pgsql,
        VaultDatabaseDriver::Sqlite => DatabaseDriver::Sqlite,
    }
}

fn map_tls(tls: VaultTls) -> DatabaseTls {
    match tls {
        VaultTls::Disabled => DatabaseTls::Disabled,
        VaultTls::Required => DatabaseTls::Required,
        VaultTls::VerifyCa => DatabaseTls::VerifyCa,
        VaultTls::VerifyFull => DatabaseTls::VerifyFull,
    }
}

/// Converts a [`VaultDatabase`] listing entry into a [`PanelConnection`] (never holds a password).
#[must_use]
pub(super) fn panel_connection_from_vault(db: &VaultDatabase) -> PanelConnection {
    PanelConnection {
        id: format!("vault:{}", db.id),
        name: db.name.clone(),
        source: ConnectionSource::Vault,
        connection: DatabaseConnection {
            driver: map_driver(db.driver),
            host: db.host.clone(),
            port: Some(db.port),
            database: db.database.clone(),
            username: db.username.clone(),
            password: String::new(),
            vault_item_id: Some(db.id.clone()),
            ssh: None,
        },
        ssh_host: db.ssh_host.clone(),
        organization: db.organization.clone(),
    }
}

/// Resolves `vault_item_id` database connections through the macOS Vault app bridge.
#[derive(Debug, Clone)]
pub(super) struct VaultCredentialResolver {
    vault: VaultClient,
}

impl VaultCredentialResolver {
    #[must_use]
    pub(super) fn new(vault: VaultClient) -> Self {
        Self { vault }
    }
}

impl DatabaseCredentialResolver for VaultCredentialResolver {
    fn resolve<'a>(&'a self, item_id: &'a str, allow_unlock: bool) -> CredentialFuture<'a> {
        let vault = self.vault.clone();
        let item_id = item_id.to_owned();
        Box::pin(async move {
            let cred = vault
                .database_credential(&item_id, allow_unlock)
                .await
                .map_err(|err| err.message)?;
            let ssh = cred.database.ssh_host.map(|host| DatabaseSsh {
                host,
                port: cred.database.ssh_port,
                user: cred.database.ssh_user,
                agent: cred.ssh_agent,
            });
            let connection = DatabaseConnection {
                driver: map_driver(cred.database.driver),
                host: cred.database.host,
                port: Some(cred.database.port),
                database: cred.database.database,
                username: cred.database.username,
                password: cred.password,
                vault_item_id: None,
                ssh,
            };
            Ok(ResolvedDatabaseCredential {
                connection,
                tls: Some(map_tls(cred.database.tls)),
            })
        })
    }
}
