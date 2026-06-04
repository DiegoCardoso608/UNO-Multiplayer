// ============================================================
//  AUTH — Google OAuth2 + Steam (Passport.js)
//  Cole este arquivo como auth.js no seu projeto e faça
//  require('./auth')(app, io) no seu server.js principal.
// ============================================================

// npm install passport passport-google-oauth20 passport-steam express-session

const passport      = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session       = require('express-session');

module.exports = function setupAuth(app) {

  // ── Sessão ─────────────────────────────────────────────────
  app.use(session({
    secret: process.env.SESSION_SECRET || 'uno-super-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 dias
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  // ── Serialização ───────────────────────────────────────────
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  // ── Google OAuth2 ──────────────────────────────────────────
  // Variáveis de ambiente necessárias:
  //   GOOGLE_CLIENT_ID     → no Google Cloud Console, credenciais OAuth
  //   GOOGLE_CLIENT_SECRET → idem
  //   BASE_URL             → ex: http://localhost:3000  ou  https://seusite.com
  //
  // No Google Cloud Console:
  //   1. Acesse https://console.cloud.google.com/apis/credentials
  //   2. Crie um projeto → Credenciais → Criar ID do cliente OAuth
  //   3. Tipo: Aplicativo Web
  //   4. URI de redirecionamento autorizado: ${BASE_URL}/auth/google/callback

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.BASE_URL || 'http://localhost:3000'}/auth/google/callback`,
    }, (accessToken, refreshToken, profile, done) => {
      const user = {
        id:       'google_' + profile.id,
        name:     profile.displayName,
        avatar:   profile.photos?.[0]?.value || null,
        provider: 'google',
      };
      return done(null, user);
    }));

    // Iniciar login Google
    app.get('/auth/google', passport.authenticate('google', {
      scope: ['profile'],
    }));

    // Callback Google
    app.get('/auth/google/callback',
      passport.authenticate('google', { failureRedirect: '/?error=google' }),
      (req, res) => res.redirect('/lobby')
    );
  } else {
    // Rota de aviso quando Google não está configurado
    app.get('/auth/google', (req, res) => {
      res.redirect('/?error=google_not_configured');
    });
  }

  // ── Steam (mantido do original) ────────────────────────────
  // npm install passport-steam
  // Variável de ambiente: STEAM_API_KEY
  try {
    const SteamStrategy = require('passport-steam').Strategy;
    if (process.env.STEAM_API_KEY) {
      passport.use(new SteamStrategy({
        returnURL: `${process.env.BASE_URL || 'http://localhost:3000'}/auth/steam/return`,
        realm:     `${process.env.BASE_URL || 'http://localhost:3000'}/`,
        apiKey:    process.env.STEAM_API_KEY,
      }, (identifier, profile, done) => {
        const user = {
          id:       'steam_' + profile.id,
          name:     profile.displayName,
          avatar:   profile.photos?.[2]?.value || profile.photos?.[0]?.value || null,
          provider: 'steam',
        };
        return done(null, user);
      }));

      app.get('/auth/steam',        passport.authenticate('steam'));
      app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }),
        (req, res) => res.redirect('/lobby')
      );
    }
  } catch(e) {
    // passport-steam não instalado — ignorar
  }

  // ── Rotas comuns ───────────────────────────────────────────
  // Retorna dados do usuário atual (usado pelos HTMLs para decidir o que exibir)
  app.get('/auth/user', (req, res) => {
    if (req.isAuthenticated() && req.user) {
      res.json({ authenticated: true, user: req.user });
    } else {
      res.json({ authenticated: false });
    }
  });

  // Logout
  app.get('/auth/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
  });
};
