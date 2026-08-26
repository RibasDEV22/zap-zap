const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Configuração das Variáveis de Ambiente no Render (Recomendado)
// Em vez de salvar a chave em arquivo físico, leia direto do Render
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY 
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') 
  : null;

let drive = null;

if (SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY) {
  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  drive = google.drive({ version: 'v3', auth });
}

/**
 * Envia uma cópia do banco de dados SQLite para o Google Drive
 * @param {string} dbFilePath - Caminho do arquivo .db local
 */
async function uploadDatabaseBackup(dbFilePath) {
  if (!drive || !FOLDER_ID) {
    console.warn('[Drive Backup] Credenciais do Google Drive não configuradas nas variáveis de ambiente.');
    return;
  }

  try {
    const fileName = `backup_sqlite_${new Date().toISOString().replace(/[:.]/g, '-')}.db`;

    const fileMetadata = {
      name: fileName,
      parents: [FOLDER_ID]
    };

    const media = {
      mimeType: 'application/x-sqlite3',
      body: fs.createReadStream(dbFilePath)
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name'
    });

    console.log(`[Drive Backup] Backup realizado com sucesso: ${response.data.name} (ID: ${response.data.id})`);
  } catch (err) {
    console.error('[Drive Backup Error] Falha ao enviar backup para o Drive:', err.message);
  }
}

module.exports = { uploadDatabaseBackup };
