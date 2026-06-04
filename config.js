// ============================================================
//  UNO GAME — CONFIGURAÇÃO
//  Edite este arquivo com suas informações
// ============================================================
module.exports = {
  PORT: 3000,

  // ── OAuth ─────────────────────────────────────────────────
  // Preencha com suas credenciais reais
  STEAM_API_KEY:    process.env.STEAM_API_KEY    || ' API_HERE ',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || ' API_HERE ',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || ' API_HERE ',

  // ── URLs ───────────────────────────────────────────────────
  // Em desenvolvimento: http://localhost:3002
  // Em produção: https://seudominio.com
BASE_URL: process.env.BASE_URL || 'http://localhost:3000',

  SESSION_SECRET: process.env.SESSION_SECRET || ' ',

  // ── Salas ─────────────────────────────────────────────────
  MAX_PLAYERS_PER_ROOM: 10,
  MIN_PLAYERS_TO_START: 2,
};