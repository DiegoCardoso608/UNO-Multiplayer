// ============================================================
//  UNO GAME ENGINE — REESCRITO DO ZERO
//  Baseado em UNO_ARQUITETURA.md
//
//  PRINCÍPIOS CENTRAIS:
//  1. Servidor é ÚNICA fonte de verdade
//  2. playableCardIds enviado em CADA getState()
//  3. Cliente NUNCA recalcula lógica de jogo
//  4. drawUntilPlay: compra 1, não jogável = passa a vez (ZERO loop)
//  5. multiPlay: cadeia automática controlada pelo servidor
//  6. Cada regra é uma função isolada
//  7. canStack existe SOMENTE aqui — nunca no cliente
// ============================================================

'use strict';

const COLORS      = ['red', 'green', 'blue', 'yellow'];
const VALUES      = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
const WILD_VALUES = ['wild', 'wild4'];
const NUMERICS    = new Set(['0','1','2','3','4','5','6','7','8','9']);

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (const value of VALUES) {
      deck.push({ color, value, id: color + '_' + value + '_a' });
      if (value !== '0') deck.push({ color, value, id: color + '_' + value + '_b' });
    }
  }
  for (const value of WILD_VALUES) {
    for (let i = 0; i < 4; i++) deck.push({ color: 'wild', value, id: value + '_' + i });
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlay(card, topCard, currentColor) {
  if (card.value === 'wild' || card.value === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function canPlayWild4Restricted(hand, currentColor) {
  return !hand.some(c => c.color === currentColor);
}

// EXISTE SOMENTE AQUI. O cliente nunca executa este cálculo.
function canStack(card, pendingDraw, pendingWild4, rules) {
  if (pendingDraw === 0) return false;
  // REGRA FUNDAMENTAL: draw2 NUNCA empilha sobre wild4 — ordem só cresce (+2→+4, nunca +4→+2)
  if (pendingWild4 && card.value === 'draw2') return false;
  if (rules.stackMix) {
    if (card.value === 'wild4') return true;
    if (card.value === 'draw2') return true; // pendingWild4 já foi descartado acima
    return false;
  }
  if (rules.stackDraw4 && card.value === 'wild4' && pendingWild4) return true;
  if (rules.stackDraw2 && card.value === 'draw2') return true; // pendingWild4 já foi descartado acima
  return false;
}

// O cliente usa este array diretamente — nunca recalcula.
function calcPlayableIds(hand, topCard, currentColor, pendingDraw, pendingWild4, rules, drawnThisTurn) {
  if (!topCard || !hand) return [];
  const stackingActive = rules.stackDraw2 || rules.stackDraw4 || rules.stackMix;
  return hand.filter(card => {
    if (pendingDraw > 0 && stackingActive) return canStack(card, pendingDraw, pendingWild4, rules);
    if (pendingDraw > 0 && !stackingActive) return false;
    if (card.value === 'wild4' && !rules.wild4NoRestriction) return canPlayWild4Restricted(hand, currentColor);
    return canPlay(card, topCard, currentColor);
  }).map(c => c.id);
}

class UnoGame {
  constructor(roomId, players, rules = {}) {
    this.roomId = roomId;
    this.rules = {
      startCards:         rules.startCards         ?? 7,
      stackDraw2:         rules.stackDraw2         ?? false,
      stackDraw4:         rules.stackDraw4         ?? false,
      stackMix:           rules.stackMix           ?? false,
      rule7:              rules.rule7              ?? false,
      rule0:              rules.rule0              ?? false,
      rule9:              rules.rule9              ?? false,
      drawUntilPlay:      rules.drawUntilPlay      ?? false,
      multiPlay:          rules.multiPlay          ?? false,
      wild4NoRestriction: rules.wild4NoRestriction ?? true,
      glowCards:          rules.glowCards          ?? true,
      turnTimer:          rules.turnTimer          ?? true,
    };
    this.players = players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar || null,
      hand: [], saidUno: false, drawnThisTurn: false, drawCount: 0, afkStrikes: 0,
    }));
    this.deck = []; this.discardPile = [];
    this.currentPlayerIndex = 0; this.direction = 1;
    this.currentColor = null; this.pendingDraw = 0; this.pendingWild4 = false;
    this.gameOver = false; this.winner = null; this.turnCount = 0;
    this.started = false; this.playerOrder = [];
    this.pendingSwap = null; this.pendingTable9 = null; this.pendingChain = null;
  }

  start() {
    this.deck = shuffle(createDeck());
    const n = this.rules.startCards;
    for (const player of this.players) player.hand = this.deck.splice(0, n);
    let firstCard;
    do {
      firstCard = this.deck.shift();
      if (firstCard.color === 'wild') { this.deck.push(firstCard); this.deck = shuffle(this.deck); }
    } while (firstCard.color === 'wild');
    this.discardPile = [firstCard];
    this.currentColor = firstCard.color;
    this._applyFirstCard(firstCard);
    this.started = true;
    this.playerOrder = this.players.map(p => p.id);
    return this.getState();
  }

  _applyFirstCard(card) {
    const n = this.players.length;
    if (card.value === 'skip') { this.currentPlayerIndex = 1 % n; }
    else if (card.value === 'reverse') {
      if (n === 2) { this.currentPlayerIndex = 1 % n; }
      else { this.direction = -1; this.currentPlayerIndex = n - 1; }
    } else if (card.value === 'draw2') {
      this.players[0].hand.push(...this._drawFromDeck(2));
      this.currentPlayerIndex = 1 % n;
    }
  }

  _drawFromDeck(count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) this._recycleDeck();
      if (this.deck.length > 0) drawn.push(this.deck.shift());
    }
    return drawn;
  }

  _recycleDeck() {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile.pop();
    this.deck = shuffle(this.discardPile);
    this.discardPile = [top];
  }

  topCard()       { return this.discardPile[this.discardPile.length - 1]; }
  currentPlayer() { return this.players[this.currentPlayerIndex]; }

  _nextIndex(steps = 1) {
    const n = this.players.length;
    return ((this.currentPlayerIndex + this.direction * steps) % n + n) % n;
  }

  _advanceTurn(skip = false) {
    const p = this.players[this.currentPlayerIndex];
    if (p) { p.drawnThisTurn = false; p.drawCount = 0; }
    this.currentPlayerIndex = this._nextIndex(skip ? 2 : 1);
    this.turnCount++;
    this.pendingChain = null;
  }

  _getPlayer(id) { return this.players.find(p => p.id === id) ?? null; }

  playCard(playerId, cardId, chosenColor = null) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (this.pendingSwap?.initiatorId === playerId) return { error: 'Resolva a troca de mão primeiro' };
    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return { error: 'Carta não encontrada na mão' };
    const card = player.hand[cardIdx];
    let playableIds = this.pendingChain?.playerId === playerId
      ? this.pendingChain.eligible
      : calcPlayableIds(player.hand, this.topCard(), this.currentColor, this.pendingDraw, this.pendingWild4, this.rules, player.drawnThisTurn);
    if (!playableIds.includes(cardId)) return { error: 'Carta não pode ser jogada agora' };
    player.hand.splice(cardIdx, 1);
    if (player.hand.length > 1) player.saidUno = false;
    player.drawnThisTurn = false; player.drawCount = 0;
    this.discardPile.push(card);
    if (card.color !== 'wild') this.currentColor = card.color;
    else if (chosenColor && COLORS.includes(chosenColor)) this.currentColor = chosenColor;
    if (player.hand.length === 0) {
      this.gameOver = true; this.winner = player; this.pendingChain = null;
      return { played: card, effect: 'win', gameOver: true, winner: player, state: this.getState() };
    }
    const result = this._applyCardEffect(card, player, chosenColor);
    result.played = card; result.state = this.getState();
    return result;
  }

  _applyCardEffect(card, player, chosenColor) {
    const result = { effect: null };
    switch (card.value) {
      case 'skip': this._advanceTurn(true); result.effect = 'skip'; break;
      case 'reverse':
        this.direction *= -1;
        if (this.players.length === 2) { this._advanceTurn(true); result.effect = 'reverse_skip'; }
        else { this._advanceTurn(); result.effect = 'reverse'; }
        break;
      case 'draw2': {
        const s2 = this.rules.stackDraw2 || this.rules.stackMix;
        if (s2) {
          this.pendingDraw += 2; this._advanceTurn();
          result.effect = 'draw2'; result.pendingDraw = this.pendingDraw;
        } else {
          const ni = this._nextIndex(1);
          this.players[ni].hand.push(...this._drawFromDeck(2));
          this._advanceTurn(true); result.effect = 'draw2_instant'; result.forced = 2;
        }
        break;
      }
      case 'wild4': {
        const s4 = this.rules.stackDraw4 || this.rules.stackMix;
        if (s4) {
          this.pendingDraw += 4; this.pendingWild4 = true; this._advanceTurn();
          result.effect = 'wild4'; result.pendingDraw = this.pendingDraw; result.needsColor = !chosenColor;
        } else {
          const ni = this._nextIndex(1);
          this.players[ni].hand.push(...this._drawFromDeck(4));
          this._advanceTurn(true); result.effect = 'wild4_instant'; result.forced = 4; result.needsColor = !chosenColor;
        }
        break;
      }
      case 'wild': this._advanceTurn(); result.effect = 'wild'; result.needsColor = !chosenColor; break;
      case '7':
        if (this.rules.rule7) {
          // BUG-012 FIX: se multiPlay ativo e ainda há outro 7 na mão, continua a cadeia
          if (this.rules.multiPlay) {
            const more7 = player.hand.filter(c => c.value === '7').map(c => c.id);
            if (more7.length > 0) {
              this.pendingChain = { playerId: player.id, value: '7', eligible: more7 };
              result.effect = 'numeric_chain'; result.chainEligible = more7; return result;
            }
          }
          // Último 7 (ou multiPlay OFF) → dispara efeito
          this.pendingSwap = { initiatorId: player.id }; result.effect = '7swap_pending'; return result;
        }
        this._advanceTurn(); break;
      case '0':
        if (this.rules.rule0) { this._rotateHands(); this._advanceTurn(); result.effect = '0rotate'; break; }
        this._advanceTurn(); break;
      case '9':
        if (this.rules.rule9) {
          // BUG-012 FIX: se multiPlay ativo e ainda há outro 9 na mão, continua a cadeia
          if (this.rules.multiPlay) {
            const more9 = player.hand.filter(c => c.value === '9').map(c => c.id);
            if (more9.length > 0) {
              this.pendingChain = { playerId: player.id, value: '9', eligible: more9 };
              result.effect = 'numeric_chain'; result.chainEligible = more9; return result;
            }
          }
          // Último 9 (ou multiPlay OFF) → dispara efeito de mesa
          this.pendingTable9 = { playerId: player.id, hitters: new Set() };
          result.effect = '9table'; result.pendingTable9 = true;
          this._advanceTurn(); return result;
        }
        this._advanceTurn(); break;
      default:
        if (this.rules.multiPlay && NUMERICS.has(card.value)) {
          const eligible = player.hand.filter(c => c.value === card.value).map(c => c.id);
          if (eligible.length > 0) {
            this.pendingChain = { playerId: player.id, value: card.value, eligible };
            result.effect = 'numeric_chain'; result.chainEligible = eligible; return result;
          }
        }
        this._advanceTurn(); break;
    }
    result.nextPlayer = this.currentPlayer();
    return result;
  }

  endChain(playerId) {
    if (!this.pendingChain || this.pendingChain.playerId !== playerId) return { error: 'Sem cadeia pendente' };
    this.pendingChain = null;
    this._advanceTurn();
    return { success: true, state: this.getState() };
  }

  // Jogar múltiplas cartas do mesmo valor de uma vez (modo seleção manual, multiPlay ON).
  // Valida que todas as cartas têm o mesmo valor e são jogáveis.
  // Joga uma a uma internamente, sem avançar o turno entre elas.
  playMultiple(playerId, cardIds) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (!Array.isArray(cardIds) || cardIds.length < 2) return { error: 'Selecione pelo menos 2 cartas' };
    if (!this.rules.multiPlay) return { error: 'MultiPlay não está ativado' };

    // Valida que todas as cartas existem na mão e têm o mesmo valor
    const cards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: 'Uma ou mais cartas não encontradas na mão' };
    const value = cards[0].value;
    if (!NUMERICS.has(value)) return { error: 'MultiPlay manual só é válido para cartas numéricas' };
    if (!cards.every(c => c.value === value)) return { error: 'Todas as cartas devem ter o mesmo número' };

    // Valida que a primeira carta é jogável no estado atual
    if (!canPlay(cards[0], this.topCard(), this.currentColor)) return { error: 'Primeira carta não é jogável agora' };

    const played = [];
    let lastEffect = null;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const idx = player.hand.findIndex(c => c.id === card.id);
      if (idx === -1) return { error: 'Carta desapareceu da mão durante jogada múltipla' };
      player.hand.splice(idx, 1);
      if (player.hand.length > 1) player.saidUno = false;
      this.discardPile.push(card);
      this.currentColor = card.color;
      played.push(card);

      // Checa vitória após cada carta
      if (player.hand.length === 0) {
        this.gameOver = true; this.winner = player; this.pendingChain = null;
        return { played, effect: 'win', gameOver: true, winner: player, state: this.getState() };
      }
    }

    // Após todas as cartas, avança o turno normalmente
    player.drawnThisTurn = false; player.drawCount = 0;
    this._advanceTurn();
    return { played, effect: 'multi', gameOver: false, state: this.getState() };
  }

  drawCard(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (this.pendingDraw > 0) {
      const drawn = this._drawFromDeck(this.pendingDraw);
      player.hand.push(...drawn); this.pendingDraw = 0; this.pendingWild4 = false;
      this._advanceTurn();
      return { drew: drawn, forced: true, skipTurn: false, state: this.getState() };
    }
    if (this.rules.drawUntilPlay) {
      // BUG-drawUntilPlay FIX: compra voluntária NUNCA encerra o turno.
      // O turno só termina se o jogador jogar uma carta ou o timer expirar.
      const drawn = this._drawFromDeck(1);
      if (drawn.length === 0) { return { drew: [], canPlay: false, skipTurn: false, state: this.getState() }; }
      player.hand.push(...drawn); player.drawCount++;
      if (player.hand.length > 1) player.saidUno = false;
      const playable = canPlay(drawn[0], this.topCard(), this.currentColor);
      // Independente de ser jogável ou não, a vez NÃO passa — jogador decide o que fazer
      player.drawnThisTurn = true;
      return { drew: drawn, canPlay: playable, skipTurn: false, justDrewId: drawn[0].id, state: this.getState() };
    }
    if (player.drawnThisTurn) return { error: 'Você já comprou neste turno. Jogue ou passe a vez.' };
    const drawn = this._drawFromDeck(1);
    if (drawn.length === 0) { this._advanceTurn(); return { drew: [], canPlay: false, skipTurn: true, state: this.getState() }; }
    player.hand.push(...drawn); player.drawCount++;
    if (player.hand.length > 1) player.saidUno = false;
    const playable = canPlay(drawn[0], this.topCard(), this.currentColor);
    // BUG-001 FIX: carta comprada não jogável → passa a vez automaticamente.
    // O jogador só fica com a vez (drawnThisTurn=true) se puder jogar a carta comprada.
    if (!playable) {
      this._advanceTurn();
      return { drew: drawn, canPlay: false, skipTurn: true, justDrewId: drawn[0].id, state: this.getState() };
    }
    player.drawnThisTurn = true;
    return { drew: drawn, canPlay: true, skipTurn: false, justDrewId: drawn[0].id, state: this.getState() };
  }

  skipTurn(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (!player.drawnThisTurn && !this.rules.drawUntilPlay) return { error: 'Compre uma carta antes de pular' };
    this._advanceTurn();
    return { success: true, state: this.getState() };
  }

  timeoutTurn(playerId) {
    const player = this._getPlayer(playerId);
    if (!player || this.currentPlayer().id !== playerId) return { error: 'Fora de turno' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    this.pendingChain = null;
    let drew = [];
    if (this.pendingDraw > 0) {
      drew = this._drawFromDeck(this.pendingDraw); player.hand.push(...drew);
      this.pendingDraw = 0; this.pendingWild4 = false;
    } else if (!player.drawnThisTurn) {
      drew = this._drawFromDeck(1); player.hand.push(...drew);
    }
    player.afkStrikes = (player.afkStrikes || 0) + 1;
    this._advanceTurn();
    return { drew, timedOut: true, afkStrikes: player.afkStrikes, state: this.getState() };
  }

  autoPlayAfk(playerId) {
  const player = this._getPlayer(playerId);
  if (!player || this.currentPlayer().id !== playerId) return { error: 'Fora de turno' };
  if (this.gameOver) return { error: 'Jogo encerrado' };

  this.pendingChain = null;

  // 1) Se há pendingDraw, compra e passa — ignora empilhamento no AFK
  if (this.pendingDraw > 0) {
    const drew = this._drawFromDeck(this.pendingDraw);
    player.hand.push(...drew);
    this.pendingDraw = 0;
    this.pendingWild4 = false;
    player.afkStrikes = (player.afkStrikes || 0) + 1;
    this._advanceTurn();
    return { drew, playedCard: null, skipTurn: true, afkStrikes: player.afkStrikes, state: this.getState() };
  }

  // 2) Compra 1 carta
  const drew = this._drawFromDeck(1);
  if (drew.length > 0) player.hand.push(...drew);

  // 3) Tenta jogar a primeira carta válida (lê da direita para esquerda)
  const hand = [...player.hand].reverse();
  const topCard = this.topCard();
  let cardToPlay = null;
  let chosenColor = null;

  for (const card of hand) {
    if (canPlay(card, topCard, this.currentColor)) {
      cardToPlay = card;
      // Coringa: escolhe a cor mais frequente na mão
      if (card.value === 'wild' || card.value === 'wild4') {
        const colorCount = {};
        player.hand.forEach(c => { if (c.color !== 'wild') colorCount[c.color] = (colorCount[c.color] || 0) + 1; });
        chosenColor = Object.entries(colorCount).sort((a,b) => b[1]-a[1])[0]?.[0] || COLORS[Math.floor(Math.random()*4)];
      }
      break;
    }
  }

  player.afkStrikes = (player.afkStrikes || 0) + 1;

  if (!cardToPlay) {
    // Sem carta jogável — passa a vez
    this._advanceTurn();
    return { drew, playedCard: null, skipTurn: true, afkStrikes: player.afkStrikes, state: this.getState() };
  }

  // Joga a carta encontrada
  const cardIdx = player.hand.findIndex(c => c.id === cardToPlay.id);
  player.hand.splice(cardIdx, 1);
  if (player.hand.length > 1) player.saidUno = false;
  this.discardPile.push(cardToPlay);
  if (cardToPlay.color !== 'wild') this.currentColor = cardToPlay.color;
  else if (chosenColor) this.currentColor = chosenColor;

  if (player.hand.length === 0) {
    this.gameOver = true;
    this.winner = player;
    return { drew, playedCard: cardToPlay, chosenColor, gameOver: true, winner: player, afkStrikes: player.afkStrikes, state: this.getState() };
  }

  const effectResult = this._applyCardEffect(cardToPlay, player, chosenColor);
  return { drew, playedCard: cardToPlay, chosenColor, skipTurn: false, effect: effectResult.effect, afkStrikes: player.afkStrikes, state: this.getState() };
}

  sayUno(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (player.hand.length > 2) return { error: 'UNO só com 1 ou 2 cartas' };
    player.saidUno = true;
    return { success: true };
  }

  callUnoViolation(callerId, targetId) {
    const target = this._getPlayer(targetId);
    if (!target) return { error: 'Alvo não encontrado' };
    if (target.hand.length !== 1) return { error: 'Alvo não tem exatamente 1 carta' };
    if (target.saidUno) return { error: 'Alvo já disse UNO' };
    const penalty = this._drawFromDeck(2);
    target.hand.push(...penalty);
    return { success: true, penalized: { id: target.id, name: target.name }, drew: penalty, state: this.getState() };
  }

  executeSwap(initiatorId, targetId) {
    if (!this.pendingSwap || this.pendingSwap.initiatorId !== initiatorId) return { error: 'Sem troca pendente' };
    const initiator = this._getPlayer(initiatorId);
    const target    = this._getPlayer(targetId);
    if (!initiator || !target) return { error: 'Jogador não encontrado' };
    const tmp = initiator.hand; initiator.hand = target.hand; target.hand = tmp;
    this.pendingSwap = null; this._advanceTurn();
    return { success: true, initiatorId, targetId, initiatorCount: initiator.hand.length, targetCount: target.hand.length, state: this.getState() };
  }

  declineSwap(initiatorId) {
    if (!this.pendingSwap || this.pendingSwap.initiatorId !== initiatorId) return { error: 'Sem troca pendente' };
    this.pendingSwap = null; this._advanceTurn();
    return { success: true, declined: true, state: this.getState() };
  }

  _rotateHands() {
    const hands = this.players.map(p => p.hand);
    if (this.direction === 1) { const last = hands.pop(); hands.unshift(last); }
    else { const first = hands.shift(); hands.push(first); }
    this.players.forEach((p, i) => { p.hand = hands[i]; });
  }

  hitTable(playerId) {
    if (!this.pendingTable9) return { error: 'Sem evento de mesa pendente' };
    if (this.pendingTable9.hitters.has(playerId)) return { success: true, alreadyHit: true, state: this.getState() };
    // Registra o hit com timestamp para identificar o último
    if (!this.pendingTable9.hitTimes) this.pendingTable9.hitTimes = new Map();
    this.pendingTable9.hitTimes.set(playerId, Date.now());
    this.pendingTable9.hitters.add(playerId);
    const allHit = this.players.every(p => this.pendingTable9.hitters.has(p.id));
    if (allHit) {
      // BUG-005 FIX: todos bateram → penalizar o último (maior timestamp = mais lento)
      let lastPlayerId = null;
      let lastTime = -1;
      this.pendingTable9.hitTimes.forEach((t, pid) => {
        if (t > lastTime) { lastTime = t; lastPlayerId = pid; }
      });
      const lastPlayer = lastPlayerId ? this._getPlayer(lastPlayerId) : null;
      let penalty = [];
      if (lastPlayer) {
        penalty = this._drawFromDeck(1);
        lastPlayer.hand.push(...penalty);
      }
      this.pendingTable9 = null;
      return { success: true, allHit: true, lastPlayerId, penalty, state: this.getState() };
    }
    return { success: true, allHit: false, hitterCount: this.pendingTable9.hitters.size, totalPlayers: this.players.length, state: this.getState() };
  }

  applyMissedTable(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.pendingTable9?.hitters?.has(playerId)) return { success: true, alreadyHit: true };
    const penalty = this._drawFromDeck(2);
    player.hand.push(...penalty);
    return { success: true, drew: penalty, state: this.getState() };
  }

  clearTable9() { this.pendingTable9 = null; }

  getState() {
    const topCard = this.topCard();
    const current = this.currentPlayer();
    let playableIds = [];
    if (current && !this.gameOver) {
      if (this.pendingChain?.playerId === current.id) playableIds = this.pendingChain.eligible;
      else playableIds = calcPlayableIds(current.hand, topCard, this.currentColor, this.pendingDraw, this.pendingWild4, this.rules, current.drawnThisTurn);
    }
    return {
      roomId: this.roomId, started: this.started, gameOver: this.gameOver,
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null,
      currentPlayerIndex: this.currentPlayerIndex, currentPlayerId: current?.id ?? null,
      direction: this.direction, currentColor: this.currentColor, topCard,
      deckCount: this.deck.length, pendingDraw: this.pendingDraw, pendingWild4: this.pendingWild4,
      pendingSwap: this.pendingSwap ?? null,
      pendingTable9: this.pendingTable9 ? { playerId: this.pendingTable9.playerId, hitters: Array.from(this.pendingTable9.hitters) } : null,
      pendingChain: this.pendingChain ? { playerId: this.pendingChain.playerId, value: this.pendingChain.value, eligible: this.pendingChain.eligible } : null,
      playableCardIds: playableIds,
      turnCount: this.turnCount, rules: this.rules, playerOrder: this.playerOrder,
      players: this.players.map(p => ({
        id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand.length,
        saidUno: p.saidUno, drawnThisTurn: p.drawnThisTurn, afkStrikes: p.afkStrikes || 0,
      })),
    };
  }

  getPlayerState(playerId) {
    const state  = this.getState();
    const player = this._getPlayer(playerId);
    return { ...state, myHand: player ? player.hand : [] };
  }

  hasStackableCard(playerId) {
    if (this.pendingDraw === 0) return false;
    const player = this._getPlayer(playerId);
    if (!player) return false;
    return player.hand.some(c => canStack(c, this.pendingDraw, this.pendingWild4, this.rules));
  }

  getPlayableIdsFor(playerId) {
    const player = this._getPlayer(playerId);
    if (!player || this.currentPlayer()?.id !== playerId) return [];
    if (this.pendingChain?.playerId === playerId) return this.pendingChain.eligible;
    return calcPlayableIds(player.hand, this.topCard(), this.currentColor, this.pendingDraw, this.pendingWild4, this.rules, player.drawnThisTurn);
  }
}

module.exports = { UnoGame, canPlay, canStack, calcPlayableIds, COLORS, NUMERICS };
