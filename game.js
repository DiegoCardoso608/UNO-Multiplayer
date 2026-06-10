// ============================================================
//  UNO GAME ENGINE — v5
//
//  CORREÇÕES:
//
//  [FIX-1] _beginColorPhase — API unificada e atômica para iniciar
//    a fase de escolha de cor. Substitui startColorTimer +
//    _pendingColorAdvance separados. O advance fica DENTRO de
//    pendingColorChoice para nunca desincronizar.
//
//  [FIX-2] resolveColorTimeout recebe advance como parâmetro
//    (capturado no closure do timer), não depende de estado externo.
//
//  [FIX-3] _resolveColorAdvance — lógica centralizada de avanço
//    pós-cor. Chamada tanto por resolveColorChoice quanto por
//    resolveColorTimeout.
//
//  [FIX-4] endChain — chain de +2 sem stacking aplica pendingDraw
//    ao próximo e pula com _advanceTurn(true). Com stacking avança
//    normalmente. chain de wild/+4 retorna needsColor + colorAdvance.
//
//  [FIX-5] playCard — não aceita mais chosenColor inline para wild
//    (evita bypass da fase de cor). Cor só é definida via
//    resolveColorChoice.
//
//  [FIX-6] autoPlayAfk — extrai advance de pendingColorChoice antes
//    de cancelar, resolve corretamente.
//
//  [FIX-7] jumpIn retorna colorAdvance junto com needsColor.
//
//  [FIX-8] _applyCardEffect retorna _colorAdvance em vez de setar
//    _pendingColorAdvance (estado separado removido).
// ============================================================

'use strict';

const { CardManager, COLORS, TOTAL_CARDS } = require('./card-manager');

const NUMERICS = new Set(['0','1','2','3','4','5','6','7','8','9']);
const WILD_COLOR_TIMEOUT_MS = 12000;

// ─── Regras puras ─────────────────────────────────────────

function canPlay(card, topCard, currentColor) {
  if (card.value === 'wild' || card.value === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function canPlayWild4Restricted(hand, currentColor) {
  return !hand.some(c => c.color === currentColor);
}

function canStack(card, pendingDraw, pendingWild4, rules) {
  if (pendingDraw === 0) return false;
  if (rules.stackFree) return card.value === 'wild4' || card.value === 'draw2';
  if (rules.stackMix)  return card.value === 'wild4' || card.value === 'draw2';
  if (rules.stackDraw4 && card.value === 'wild4' && pendingWild4) return true;
  if (rules.stackDraw2 && card.value === 'draw2' && !pendingWild4) return true;
  return false;
}

function calcPlayableIds(hand, topCard, currentColor, pendingDraw, pendingWild4, rules) {
  if (!topCard || !hand) return [];
  const stackingActive = rules.stackDraw2 || rules.stackDraw4 || rules.stackMix || rules.stackFree;
  return hand.filter(card => {
    if (pendingDraw > 0 && stackingActive)  return canStack(card, pendingDraw, pendingWild4, rules);
    if (pendingDraw > 0 && !stackingActive) return false;
    if (card.value === 'wild4' && !rules.wild4NoRestriction) return canPlayWild4Restricted(hand, currentColor);
    return canPlay(card, topCard, currentColor);
  }).map(c => c.id);
}

// ─── Classe Principal ─────────────────────────────────────

class UnoGame {
  constructor(roomId, players, rules = {}) {
    this.roomId = roomId;
    this.rules = {
      startCards:         rules.startCards         ?? 7,
      stackDraw2:         rules.stackDraw2         ?? false,
      stackDraw4:         rules.stackDraw4         ?? false,
      stackMix:           rules.stackMix           ?? false,
      stackFree:          rules.stackFree          ?? false,
      rule7:              rules.rule7              ?? false,
      rule0:              rules.rule0              ?? false,
      rule9:              rules.rule9              ?? false,
      drawUntilPlay:      rules.drawUntilPlay      ?? false,
      drawInfinite:       rules.drawInfinite       ?? false,
      deckInfinite:       rules.deckInfinite       ?? false,
      jumpIn:             rules.jumpIn             ?? false,
      multiPlay:          rules.multiPlay          ?? false,
      multiPlaySpecial:   rules.multiPlaySpecial   ?? false,
      wild4NoRestriction: rules.wild4NoRestriction ?? true,
      glowCards:          rules.glowCards          ?? true,
      turnTimer:          rules.turnTimer          ?? true,
    };

    this.players = players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar || null,
      saidUno: false, drawnThisTurn: false, drawCount: 0, afkStrikes: 0,
    }));

    this.cm = new CardManager();

    this.currentColor       = null;
    this.pendingDraw        = 0;
    this.pendingWild4       = false;
    this.gameOver           = false;
    this.winner             = null;
    this.turnCount          = 0;
    this.started            = false;
    this.playerOrder        = [];
    this.currentPlayerIndex = 0;
    this.direction          = 1;

    this.pendingSwap        = null;
    this.pendingTable9      = null;
    this.pendingChain       = null;
    this.mustPlayCardId     = null;

    // [FIX-1] Único objeto de estado de cor.
    // Estrutura: { playerId, cardId, timer, advance: { skip } }
    // advance.skip=true → wild4 sem stacking: aplica 4 ao próximo e pula
    this.pendingColorChoice = null;
  }

  // ─── Setup ──────────────────────────────────────────────

  start() {
    this.cm.init();
    this.cm.infiniteMode = !!this.rules.deckInfinite;
    for (const player of this.players) {
      this.cm.addPlayer(player.id);
      this.cm.deal(player.id, this.rules.startCards);
    }
    let firstCard;
    do {
      const drawn = this.cm._drawFromDeck(1);
      if (!drawn.length) break;
      firstCard = drawn[0];
      if (firstCard.color === 'wild') {
        this.cm.deck.push(firstCard);
        this.cm.deck = _shuffle(this.cm.deck);
        firstCard = null;
      }
    } while (!firstCard);

    this.cm.discardPile.push(firstCard);
    this.currentColor = firstCard.color;
    this._applyFirstCard(firstCard);
    this.started     = true;
    this.startedAt   = Date.now();
    this.playerOrder = this.players.map(p => p.id);
    this._validate('start');
    return this.getState();
  }

  _applyFirstCard(card) {
    const n = this.players.length;
    if (card.value === 'skip') {
      this.currentPlayerIndex = 1 % n;
    } else if (card.value === 'reverse') {
      if (n === 2) this.currentPlayerIndex = 1 % n;
      else { this.direction = -1; this.currentPlayerIndex = n - 1; }
    } else if (card.value === 'draw2') {
      this.cm.draw(this.players[0].id, 2);
      this.currentPlayerIndex = 1 % n;
    }
  }

  // ─── Navegação ───────────────────────────────────────────

  topCard()       { return this.cm.topCard(); }
  currentPlayer() { return this.players[this.currentPlayerIndex]; }
  isPendingColor(){ return !!this.pendingColorChoice; }

  _nextIndex(steps = 1) {
    const n = this.players.length;
    return ((this.currentPlayerIndex + this.direction * steps) % n + n) % n;
  }

  _advanceTurn(skip = false) {
    const p = this.players[this.currentPlayerIndex];
    if (p) { p.drawnThisTurn = false; p.drawCount = 0; p.drawSequence = []; p.drawSequenceFoundPlayable = false; }
    this.currentPlayerIndex = this._nextIndex(skip ? 2 : 1);
    this.turnCount++;
    this.pendingChain   = null;
    this.mustPlayCardId = null;
    if (this.pendingSwap) this.pendingSwap = null;
  }

  _getPlayer(id) { return this.players.find(p => p.id === id) ?? null; }

  // ─── Auditoria ───────────────────────────────────────────

  _validate(ctx = '') {
    const r = this.cm.validate({ throw: false });
    if (!r.valid) { console.error(`[UnoGame] Audit falhou em "${ctx}":`, r.errors); this.cm.autoRepair(); }
  }

  // ─── [FIX-1] Fase de Cor — API unificada ─────────────────
  //
  // _beginColorPhase(playerId, cardId, advance, onTimeout)
  //   Cria pendingColorChoice de forma atômica e inicia o timer.
  //   advance = { skip: bool }
  //   onTimeout(advance) é chamado pelo timer com o advance capturado.
  //
  // _cancelColorPhase()
  //   Cancela timer e zera pendingColorChoice. Idempotente.

  _beginColorPhase(playerId, cardId, advance, onTimeout) {
    this._cancelColorPhase(); // garante estado limpo

    const timer = setTimeout(() => {
      if (!this.pendingColorChoice || this.pendingColorChoice.playerId !== playerId) return;
      const adv = this.pendingColorChoice.advance;
      this.pendingColorChoice = null; // limpa ANTES do callback
      console.log(`[UnoGame] Cor expirou para ${playerId} — cor atual: ${this.currentColor}`);
      onTimeout(adv);
    }, WILD_COLOR_TIMEOUT_MS);

    this.pendingColorChoice = { playerId, cardId, timer, advance: advance || { skip: false } };
  }

  _cancelColorPhase() {
    if (this.pendingColorChoice?.timer) clearTimeout(this.pendingColorChoice.timer);
    this.pendingColorChoice = null;
  }

  // ─── [FIX-2] Resolver Timeout ────────────────────────────
  // advance vem do closure do timer — não depende de estado externo.

  resolveColorTimeout(playerId, advance) {
    // pendingColorChoice já foi zerado pelo timer
    this._validate('resolveColorTimeout');
    return this._resolveColorAdvance(advance || { skip: false });
  }

  // ─── Resolver Escolha Manual ─────────────────────────────

  resolveColorChoice(playerId, chosenColor) {
    if (!this.pendingColorChoice) return { error: 'Sem escolha de cor pendente' };
    if (this.pendingColorChoice.playerId !== playerId) return { error: 'Não é você que escolhe a cor' };
    if (!COLORS.includes(chosenColor)) return { error: 'Cor inválida' };

    const advance = this.pendingColorChoice.advance;
    this._cancelColorPhase();
    this.currentColor = chosenColor;
    this._validate('resolveColorChoice');
    return this._resolveColorAdvance(advance);
  }

  // ─── [FIX-3] Avanço Pós-Cor ──────────────────────────────

  _resolveColorAdvance(advance) {
    if (advance && advance.skip) {
      // wild4 sem stacking: aplica 4 ao próximo e pula
      const nextIdx = this._nextIndex(1);
      const nextId  = this.players[nextIdx].id;
      const drew    = this.cm.draw(nextId, 4);
      this._advanceTurn(true);
      return { success: true, drewCards: drew, state: this.getState() };
    }
    this._advanceTurn(false);
    return { success: true, state: this.getState() };
  }

  // ─── Compatibilidade: startColorTimer (servidor v4) ──────
  // Mantido para não quebrar chamadas existentes no index.js
  // O index.js deve ser atualizado para usar _beginColorPhase.

  startColorTimer(playerId, cardId, onColorTimeout) {
    this._beginColorPhase(playerId, cardId, { skip: false }, (_adv) => onColorTimeout());
  }

  // ─── [FIX-5] Jogar Carta ─────────────────────────────────

  playCard(playerId, cardId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (this.pendingSwap?.initiatorId === playerId) return { error: 'Resolva a troca de mão primeiro' };
    if (this.pendingTable9) return { error: 'Bata na mesa primeiro!' };
    if (this.pendingColorChoice) return { error: 'Escolha a cor antes de continuar' };

    const hand = this.cm.getHand(playerId);
    const card = hand.find(c => c.id === cardId);
    if (!card) return { error: 'Carta não encontrada na mão' };

    const playableIds = this.pendingChain?.playerId === playerId
      ? this.pendingChain.eligible
      : calcPlayableIds(hand, this.topCard(), this.currentColor, this.pendingDraw, this.pendingWild4, this.rules);

    if (!playableIds.includes(cardId)) return { error: 'Carta não pode ser jogada agora' };

    try { this.cm.play(playerId, cardId); } catch(e) { return { error: e.message }; }

    const updatedHand = this.cm.getHand(playerId);
    if (updatedHand.length > 1) player.saidUno = false;
    player.drawnThisTurn = false;
    player.drawCount     = 0;
    this.mustPlayCardId  = null;

    // Cor não-wild: atualiza imediatamente
    if (card.color !== 'wild') this.currentColor = card.color;

    if (updatedHand.length === 0) {
      this.gameOver = true;
      this.winner   = player;
      this.pendingChain = null;
      this._cancelColorPhase();
      this._validate('playCard:win');
      return { played: card, effect: 'win', gameOver: true, winner: player, state: this.getState() };
    }

    const result = this._applyCardEffect(card, player);
    result.played = card;
    result.state  = this.getState();
    this._validate(`playCard:${card.value}`);
    return result;
  }

  // ─── [FIX-8] Efeito da Carta ─────────────────────────────
  // Não seta mais _pendingColorAdvance. Retorna _colorAdvance no resultado.

  _applyCardEffect(card, player) {
    const result = { effect: null };

    switch (card.value) {

      case 'skip': {
        if (this.rules.multiPlaySpecial) {
          const more = this.cm.getHand(player.id).filter(c => c.value === 'skip').map(c => c.id);
          if (more.length > 0) {
            this.pendingChain = { playerId: player.id, value: 'skip', eligible: more };
            return { effect: 'numeric_chain', chainEligible: more };
          }
        }
        this._advanceTurn(true);
        result.effect = 'skip';
        break;
      }

      case 'reverse': {
        this.direction *= -1;
        if (this.rules.multiPlaySpecial) {
          const more = this.cm.getHand(player.id).filter(c => c.value === 'reverse').map(c => c.id);
          if (more.length > 0) {
            this.pendingChain = { playerId: player.id, value: 'reverse', eligible: more };
            return { effect: 'numeric_chain', chainEligible: more };
          }
        }
        if (this.players.length === 2) { this._advanceTurn(true); result.effect = 'reverse_skip'; }
        else { this._advanceTurn(); result.effect = 'reverse'; }
        break;
      }

      case 'draw2': {
        const s2 = this.rules.stackDraw2 || this.rules.stackMix || this.rules.stackFree;
        this.pendingDraw += 2;

        if (this.rules.multiPlaySpecial) {
          const more = this.cm.getHand(player.id).filter(c => c.value === 'draw2').map(c => c.id);
          if (more.length > 0) {
            this.pendingChain = { playerId: player.id, value: 'draw2', eligible: more, hasStacking: s2 };
            return { effect: 'numeric_chain', chainEligible: more, pendingDraw: this.pendingDraw };
          }
        }

        if (s2) {
          this._advanceTurn();
          result.effect = 'draw2'; result.pendingDraw = this.pendingDraw;
        } else {
          const ni  = this._nextIndex(1);
          const nid = this.players[ni].id;
          const drew = this.cm.draw(nid, this.pendingDraw);
          this.pendingDraw = 0;
          this._advanceTurn(true);
          result.effect = 'draw2_instant'; result.drewCards = drew; result.forced = drew.length;
        }
        break;
      }

      case 'wild4': {
        const s4 = this.rules.stackDraw4 || this.rules.stackMix || this.rules.stackFree;
        this.pendingDraw += 4;
        if (s4) this.pendingWild4 = true;

        if (this.rules.multiPlaySpecial) {
          const more = this.cm.getHand(player.id).filter(c => c.value === 'wild4').map(c => c.id);
          if (more.length > 0) {
            this.pendingChain = { playerId: player.id, value: 'wild4', eligible: more, hasStacking: s4 };
            return { effect: 'numeric_chain', chainEligible: more, pendingDraw: this.pendingDraw, needsColor: true };
          }
        }

        // [FIX-8] Retorna _colorAdvance — servidor chamará _beginColorPhase
        result.effect      = s4 ? 'wild4' : 'wild4_instant';
        result.pendingDraw = this.pendingDraw;
        result.needsColor  = true;
        result._colorAdvance = { skip: !s4 };
        break;
      }

      case 'wild': {
        if (this.rules.multiPlaySpecial) {
          const more = this.cm.getHand(player.id).filter(c => c.value === 'wild').map(c => c.id);
          if (more.length > 0) {
            this.pendingChain = { playerId: player.id, value: 'wild', eligible: more };
            return { effect: 'numeric_chain', chainEligible: more, needsColor: true };
          }
        }
        result.effect = 'wild';
        result.needsColor = true;
        result._colorAdvance = { skip: false };
        break;
      }

      case '7': {
        if (this.rules.rule7) {
          if (this.rules.multiPlay) {
            const more = this.cm.getHand(player.id).filter(c => c.value === '7').map(c => c.id);
            if (more.length > 0) {
              this.pendingChain = { playerId: player.id, value: '7', eligible: more };
              return { effect: 'numeric_chain', chainEligible: more };
            }
          }
          this.pendingSwap = { initiatorId: player.id };
          return { effect: '7swap_pending' };
        }
        this._advanceTurn(); break;
      }

      case '0': {
        if (this.rules.rule0) {
          this.cm.rotateHands(this.playerOrder, this.direction);
          this._advanceTurn();
          result.effect = '0rotate'; break;
        }
        this._advanceTurn(); break;
      }

      case '9': {
        if (this.rules.rule9) {
          if (this.rules.multiPlay) {
            const more = this.cm.getHand(player.id).filter(c => c.value === '9').map(c => c.id);
            if (more.length > 0) {
              this.pendingChain = { playerId: player.id, value: '9', eligible: more };
              return { effect: 'numeric_chain', chainEligible: more };
            }
          }
          this.pendingTable9 = { playerId: player.id, hitters: new Set(), hitTimes: new Map() };
          this._advanceTurn();
          return { effect: '9table', pendingTable9: true };
        }
        this._advanceTurn(); break;
      }

      default: {
        if (this.rules.multiPlay && NUMERICS.has(card.value)) {
          const eligible = this.cm.getHand(player.id).filter(c => c.value === card.value).map(c => c.id);
          if (eligible.length > 0) {
            this.pendingChain = { playerId: player.id, value: card.value, eligible };
            return { effect: 'numeric_chain', chainEligible: eligible };
          }
        }
        this._advanceTurn(); break;
      }
    }

    result.nextPlayer = this.currentPlayer();
    return result;
  }

  // ─── Comprar Carta ───────────────────────────────────────

  drawCard(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (this.pendingColorChoice) return { error: 'Escolha a cor antes de comprar' };
    if (this.pendingTable9) return { error: 'Bata na mesa primeiro!' };
    if (this.mustPlayCardId) return { error: 'Jogue a carta que comprou!', mustPlay: true, mustPlayCardId: this.mustPlayCardId };

    if (this.pendingDraw > 0) {
      const stackingActive = this.rules.stackDraw2 || this.rules.stackDraw4 || this.rules.stackMix || this.rules.stackFree;
      const hasStackable = this.cm.getHand(playerId).some(c => canStack(c, this.pendingDraw, this.pendingWild4, this.rules));
      if (stackingActive && hasStackable) return { error: 'Você tem carta para empilhar!', hasStackable: true };

      const drew = this.cm.draw(playerId, this.pendingDraw);
      this.pendingDraw  = 0;
      this.pendingWild4 = false;
      this._advanceTurn();
      this._validate('drawCard:forced');
      return { drew, forced: true, skipTurn: true, state: this.getState() };
    }

    if (this.rules.drawUntilPlay) {
      const topC = this.topCard(), cc = this.currentColor;

      // Se já encontrou carta jogável entre as compradas nesta sequência, bloqueia novas compras
      if (player.drawSequenceFoundPlayable)
        return { error: 'Você tem cartas jogáveis!', mustPlay: true };

      const drew = this.cm.draw(playerId, 1);
      if (!drew.length) return { drew: [], canPlay: false, skipTurn: true, state: this.getState() };
      player.drawCount++;
      if (this.cm.getHand(playerId).length > 1) player.saidUno = false;
      player.drawnThisTurn = true;

      // Rastreia apenas cartas compradas nesta sequência
      if (!player.drawSequence) player.drawSequence = [];
      player.drawSequence.push(...drew);

      // Verifica se alguma carta COMPRADA nesta sequência é jogável
      const drawnPlayable = player.drawSequence.some(c => canPlay(c, topC, cc));
      if (drawnPlayable) player.drawSequenceFoundPlayable = true;

      // Cartas jogáveis totais (para destacar na mão)
      const anyPlayable = this.cm.getHand(playerId).some(c => canPlay(c, topC, cc));
      this._validate('drawCard:drawUntilPlay');
      return { drew, canPlay: anyPlayable, mustPlay: drawnPlayable, skipTurn: false, state: this.getState() };
    }

    if (this.rules.drawInfinite) {
      const drew = this.cm.draw(playerId, 1);
      if (!drew.length) return { drew: [], canPlay: false, skipTurn: false, state: this.getState() };
      player.drawCount++;
      if (this.cm.getHand(playerId).length > 1) player.saidUno = false;
      const playable = canPlay(drew[0], this.topCard(), this.currentColor);
      this._validate('drawCard:infinite');
      return { drew, canPlay: playable, skipTurn: false, justDrewId: drew[0].id, state: this.getState() };
    }

    if (player.drawnThisTurn) return { error: 'Você já comprou neste turno.' };

    const drew = this.cm.draw(playerId, 1);
    if (!drew.length) { this._advanceTurn(); return { drew: [], canPlay: false, skipTurn: true, state: this.getState() }; }
    player.drawCount++;
    if (this.cm.getHand(playerId).length > 1) player.saidUno = false;

    const playable = canPlay(drew[0], this.topCard(), this.currentColor);
    if (!playable) {
      this._advanceTurn();
      this._validate('drawCard:noPlay');
      return { drew, canPlay: false, skipTurn: true, justDrewId: drew[0].id, state: this.getState() };
    }
    player.drawnThisTurn = true;
    this._validate('drawCard:canPlay');
    return { drew, canPlay: true, skipTurn: false, justDrewId: drew[0].id, state: this.getState() };
  }

  // ─── Pular Vez ───────────────────────────────────────────

  skipTurn(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (!player.drawnThisTurn && !this.rules.drawUntilPlay && !this.rules.drawInfinite)
      return { error: 'Compre uma carta antes de pular' };
    this._advanceTurn();
    return { success: true, state: this.getState() };
  }

  // ─── Timeout de Turno (AFK) ──────────────────────────────

  timeoutTurn(playerId) {
    const player = this._getPlayer(playerId);
    if (!player || this.currentPlayer().id !== playerId) return { error: 'Fora de turno' };
    if (this.gameOver) return { error: 'Jogo encerrado' };

    if (this.pendingColorChoice?.playerId === playerId) this._cancelColorPhase();
    this.pendingChain   = null;
    this.mustPlayCardId = null;

    let drew = [];
    if (this.pendingDraw > 0) {
      drew = this.cm.draw(playerId, this.pendingDraw);
      this.pendingDraw  = 0;
      this.pendingWild4 = false;
    } else if (!player.drawnThisTurn) {
      drew = this.cm.draw(playerId, 1);
    }

    player.afkStrikes = (player.afkStrikes || 0) + 1;
    this._advanceTurn();
    this._validate('timeoutTurn');
    return { drew, timedOut: true, afkStrikes: player.afkStrikes, state: this.getState() };
  }

  // ─── [FIX-6] AFK Auto-Play ───────────────────────────────

  autoPlayAfk(playerId) {
    const player = this._getPlayer(playerId);
    if (!player || this.currentPlayer().id !== playerId) return { error: 'Fora de turno' };
    if (this.gameOver) return { error: 'Jogo encerrado' };

    // Se estava esperando cor: extrai advance, cancela, resolve
    if (this.pendingColorChoice?.playerId === playerId) {
      const advance = this.pendingColorChoice.advance;
      this._cancelColorPhase();
      this.pendingChain   = null;
      this.mustPlayCardId = null;
      const res = this._resolveColorAdvance(advance || { skip: false });
      player.afkStrikes = (player.afkStrikes || 0) + 1;
      this._validate('autoPlayAfk:colorTimeout');
      return {
        drew: [], playedCard: null, skipTurn: true,
        colorTimedOut: true, drewCards: res.drewCards || [],
        afkStrikes: player.afkStrikes, state: this.getState(),
      };
    }

    this._cancelColorPhase();
    this.pendingChain = null;

    // mustPlay: joga a carta obrigatória
    if (this.mustPlayCardId) {
      const cardToPlay = this.cm.getHand(playerId).find(c => c.id === this.mustPlayCardId);
      this.mustPlayCardId = null;
      if (cardToPlay) {
        try { this.cm.play(playerId, cardToPlay.id); } catch(e) {}
        if (cardToPlay.color !== 'wild') this.currentColor = cardToPlay.color;
        if (!this.cm.getHand(playerId).length) {
          this.gameOver = true; this.winner = player;
          return { drew: [], playedCard: cardToPlay, gameOver: true, winner: player, afkStrikes: player.afkStrikes, state: this.getState() };
        }
        const eff = this._applyCardEffect(cardToPlay, player);
        return { drew: [], playedCard: cardToPlay, skipTurn: false, effect: eff.effect, afkStrikes: player.afkStrikes, state: this.getState() };
      }
    }

    // pendingDraw: compra forçada
    if (this.pendingDraw > 0) {
      const drew = this.cm.draw(playerId, this.pendingDraw);
      this.pendingDraw  = 0;
      this.pendingWild4 = false;
      player.afkStrikes = (player.afkStrikes || 0) + 1;
      this._advanceTurn();
      this._validate('autoPlayAfk:forced');
      return { drew, playedCard: null, skipTurn: true, afkStrikes: player.afkStrikes, state: this.getState() };
    }

    const drew = this.cm.draw(playerId, 1);
    const hand = this.cm.getHand(playerId);
    // AFK nunca joga wild/+4
    let cardToPlay = null;
    for (const card of [...hand].reverse()) {
      if (card.value === 'wild' || card.value === 'wild4') continue;
      if (canPlay(card, this.topCard(), this.currentColor)) { cardToPlay = card; break; }
    }

    player.afkStrikes = (player.afkStrikes || 0) + 1;

    if (!cardToPlay) {
      this._advanceTurn();
      this._validate('autoPlayAfk:noPlay');
      return { drew, playedCard: null, skipTurn: true, afkStrikes: player.afkStrikes, state: this.getState() };
    }

    try { this.cm.play(playerId, cardToPlay.id); } catch(e) {
      this._advanceTurn();
      return { drew, playedCard: null, skipTurn: true, afkStrikes: player.afkStrikes, state: this.getState() };
    }
    if (cardToPlay.color !== 'wild') this.currentColor = cardToPlay.color;

    if (!this.cm.getHand(playerId).length) {
      this.gameOver = true; this.winner = player;
      this._validate('autoPlayAfk:win');
      return { drew, playedCard: cardToPlay, gameOver: true, winner: player, afkStrikes: player.afkStrikes, state: this.getState() };
    }

    const eff = this._applyCardEffect(cardToPlay, player);
    this._validate('autoPlayAfk:played');
    return { drew, playedCard: cardToPlay, skipTurn: false, effect: eff.effect, afkStrikes: player.afkStrikes, state: this.getState() };
  }

  // ─── UNO ────────────────────────────────────────────────

  sayUno(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.cm.getHand(playerId).length > 2) return { error: 'UNO só com 1 ou 2 cartas' };
    player.saidUno = true;
    return { success: true };
  }

  callUnoViolation(callerId, targetId) {
    const target = this._getPlayer(targetId);
    if (!target) return { error: 'Alvo não encontrado' };
    if (this.cm.getHand(targetId).length !== 1) return { error: 'Alvo não tem 1 carta' };
    if (target.saidUno) return { error: 'Alvo já disse UNO' };
    const penalty = this.cm.draw(targetId, 2);
    this._validate('callUnoViolation');
    return { success: true, penalized: { id: target.id, name: target.name }, drew: penalty, state: this.getState() };
  }

  // ─── Regra 7 ─────────────────────────────────────────────

  executeSwap(initiatorId, targetId) {
    if (!this.pendingSwap || this.pendingSwap.initiatorId !== initiatorId) return { error: 'Sem troca pendente' };
    if (!this._getPlayer(initiatorId) || !this._getPlayer(targetId)) return { error: 'Jogador não encontrado' };
    this.cm.swapHands(initiatorId, targetId);
    const ic = this.cm.getHand(initiatorId).length;
    const tc = this.cm.getHand(targetId).length;
    this.pendingSwap = null;
    this._advanceTurn();
    this._validate('executeSwap');
    return { success: true, initiatorId, targetId, initiatorCount: ic, targetCount: tc, state: this.getState() };
  }

  declineSwap(initiatorId) {
    if (!this.pendingSwap || this.pendingSwap.initiatorId !== initiatorId) return { error: 'Sem troca pendente' };
    this.pendingSwap = null;
    this._advanceTurn();
    return { success: true, declined: true, state: this.getState() };
  }

  // ─── Regra 9 ─────────────────────────────────────────────

  hitTable(playerId) {
    if (!this.pendingTable9) return { error: 'Sem evento de mesa pendente' };
    if (this.pendingTable9.hitters.has(playerId)) return { success: true, alreadyHit: true, state: this.getState() };
    this.pendingTable9.hitTimes.set(playerId, Date.now());
    this.pendingTable9.hitters.add(playerId);
    const allHit = this.players.every(p => this.pendingTable9.hitters.has(p.id));
    if (allHit) {
      let lastPlayerId = null, lastTime = -1;
      this.pendingTable9.hitTimes.forEach((t, pid) => { if (t > lastTime) { lastTime = t; lastPlayerId = pid; } });
      const penalty = lastPlayerId ? this.cm.draw(lastPlayerId, 1) : [];
      this.pendingTable9 = null;
      this._validate('hitTable:allHit');
      return { success: true, allHit: true, lastPlayerId, penalty, state: this.getState() };
    }
    return { success: true, allHit: false, hitterCount: this.pendingTable9.hitters.size, totalPlayers: this.players.length, state: this.getState() };
  }

  applyMissedTable(playerId) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.pendingTable9?.hitters?.has(playerId)) return { success: true, alreadyHit: true };
    const penalty = this.cm.draw(playerId, 2);
    this._validate('applyMissedTable');
    return { success: true, drew: penalty, state: this.getState() };
  }

  clearTable9() { this.pendingTable9 = null; }

  // ─── [FIX-4] endChain ────────────────────────────────────

  endChain(playerId) {
    if (!this.pendingChain || this.pendingChain.playerId !== playerId) return { error: 'Sem cadeia pendente' };
    const chain = this.pendingChain;
    this.pendingChain = null;

    // +2 sem stacking: aplica acumulado ao próximo e pula
    if (chain.value === 'draw2' && !chain.hasStacking && this.pendingDraw > 0) {
      const nextId = this.players[this._nextIndex(1)].id;
      const drew   = this.cm.draw(nextId, this.pendingDraw);
      this.pendingDraw = 0;
      this._advanceTurn(true);
      return { success: true, drewCards: drew, state: this.getState() };
    }

    // +2 com stacking: próximo pode empilhar
    if (chain.value === 'draw2' && chain.hasStacking) {
      this._advanceTurn(false);
      return { success: true, state: this.getState() };
    }

    // wild / +4: precisa de cor — servidor chama _beginColorPhase
    if (chain.value === 'wild' || chain.value === 'wild4') {
      const skipNext = chain.value === 'wild4' && !chain.hasStacking;
      return { success: true, needsColor: true, colorAdvance: { skip: skipNext }, state: this.getState() };
    }

    // skip: pula próximos (acumulado)
    if (chain.value === 'skip') {
      this._advanceTurn(true);
      return { success: true, state: this.getState() };
    }

    // 7: dispara evento de troca de mão
    if (chain.value === '7' && this.rules.rule7) {
      this.pendingSwap = { initiatorId: playerId };
      return { success: true, pendingSwap: true, state: this.getState() };
    }

    // 9: dispara evento de bater na mesa
    if (chain.value === '9' && this.rules.rule9) {
      this.pendingTable9 = { playerId, hitters: new Set(), hitTimes: new Map() };
      this._advanceTurn();
      return { success: true, pendingTable9: true, state: this.getState() };
    }

    // outros (reverse, numéricos)
    this._advanceTurn();
    return { success: true, state: this.getState() };
  }

  // ─── MultiPlay Manual (legado) ────────────────────────────

  playMultiple(playerId, cardIds) {
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id !== playerId) return { error: 'Não é sua vez' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (!Array.isArray(cardIds) || cardIds.length < 2) return { error: 'Selecione pelo menos 2 cartas' };
    if (!this.rules.multiPlay && !this.rules.multiPlaySpecial) return { error: 'MultiPlay não ativado' };

    const hand  = this.cm.getHand(playerId);
    const cards = cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { error: 'Carta não encontrada na mão' };

    const firstVal  = cards[0].value;
    const isNumeric = NUMERICS.has(firstVal);
    const SPECIAL_MULTI = new Set(['draw2','wild4','skip','reverse','wild']);

    if (!cards.every(c => c.value === firstVal)) return { error: 'Todas as cartas devem ter o mesmo tipo' };
    if ( isNumeric && !this.rules.multiPlay)        return { error: 'MultiPlay numérico não ativado' };
    if (!isNumeric && !this.rules.multiPlaySpecial) return { error: 'MultiPlay especial não ativado' };
    if (!isNumeric && !SPECIAL_MULTI.has(firstVal)) return { error: 'Carta especial não suportada' };
    if (!canPlay(cards[0], this.topCard(), this.currentColor)) return { error: 'Primeira carta não jogável' };

    const played = [];
    let pendingColorNeeded = false, colorAdvance = { skip: false };
    let accumulatedDraw = 0, skipCount = 0, reverseCount = 0;

    for (const card of cards) {
      try { this.cm.play(playerId, card.id); } catch(e) { return { error: `Falha: ${e.message}` }; }
      played.push(card);
      if (card.color !== 'wild') this.currentColor = card.color;
      if (card.value === 'draw2')   accumulatedDraw += 2;
      if (card.value === 'wild4')   { accumulatedDraw += 4; pendingColorNeeded = true; }
      if (card.value === 'skip')    skipCount++;
      if (card.value === 'reverse') reverseCount++;
      if (card.value === 'wild')    pendingColorNeeded = true;
      if (!this.cm.getHand(playerId).length) {
        this.gameOver = true; this.winner = player; this.pendingChain = null;
        this._validate('playMultiple:win');
        return { played, effect: 'win', gameOver: true, winner: player, state: this.getState() };
      }
    }

    player.drawnThisTurn = false; player.drawCount = 0;
    if (reverseCount % 2 !== 0) this.direction *= -1;

    if (accumulatedDraw > 0) {
      const s = this.rules.stackDraw2 || this.rules.stackDraw4 || this.rules.stackMix || this.rules.stackFree;
      if (s) {
        this.pendingDraw += accumulatedDraw;
        if (cards.some(c => c.value === 'wild4')) this.pendingWild4 = true;
        if (pendingColorNeeded) {
          colorAdvance = { skip: false };
          return { played, effect: 'multi_special', needsColor: true, colorAdvance, pendingDraw: this.pendingDraw, state: this.getState() };
        }
        this._advanceTurn();
      } else {
        const nid = this.players[this._nextIndex(1)].id;
        this.cm.draw(nid, accumulatedDraw);
        if (pendingColorNeeded) {
          colorAdvance = { skip: true };
          return { played, effect: 'multi_special', needsColor: true, colorAdvance, pendingDraw: accumulatedDraw, state: this.getState() };
        }
        this._advanceTurn(true);
      }
    } else if (skipCount > 0) {
      // Percorre a mesa consumindo skipCount bloqueios
      // O jogador que iniciou (initIdx) NUNCA pode ser bloqueado
      const n = this.players.length;
      const initIdx = this.currentPlayerIndex;
      let idx = initIdx;
      let left = skipCount;
      while (left > 0) {
        idx = ((idx + this.direction) % n + n) % n;
        if (idx === initIdx) continue; // nunca bloqueia o próprio jogador
        left--;
      }
      // Avança mais um para o próximo jogador válido (não bloqueado)
      let nextIdx = ((idx + this.direction) % n + n) % n;
      // Se nextIdx caiu no próprio iniciador (todos bloqueados), avança mais
      if (nextIdx === initIdx && n > 1) {
        nextIdx = ((nextIdx + this.direction) % n + n) % n;
      }
      const p2 = this.players[initIdx];
      if (p2) { p2.drawnThisTurn = false; p2.drawCount = 0; p2.drawSequence = []; p2.drawSequenceFoundPlayable = false; }
      this.currentPlayerIndex = nextIdx; this.turnCount++;
      this.pendingChain = null; this.mustPlayCardId = null; this.pendingSwap = null;
    } else {
      if (pendingColorNeeded) {
        colorAdvance = { skip: false };
        return { played, effect: 'multi_special', needsColor: true, colorAdvance, state: this.getState() };
      }
      this._advanceTurn();
    }

    if (firstVal === '9' && this.rules.rule9) {
      this.pendingTable9 = { playerId: player.id, hitters: new Set(), hitTimes: new Map() };
      this._validate('playMultiple:rule9');
      return { played, effect: '9table', pendingTable9: true, state: this.getState() };
    }

    this._validate('playMultiple');
    return { played, effect: isNumeric ? 'multi' : 'multi_special', gameOver: false, state: this.getState() };
  }

  // ─── [FIX-7] Jump-In ─────────────────────────────────────

  jumpIn(playerId, cardId) {
    if (!this.rules.jumpIn) return { error: 'Jump-In não ativado' };
    if (this.gameOver) return { error: 'Jogo encerrado' };
    if (this.pendingColorChoice) return { error: 'Aguarde a escolha de cor' };
    if (this.pendingDraw > 0) return { error: 'Aguarde a resolução do +draw' };
    const player = this._getPlayer(playerId);
    if (!player) return { error: 'Jogador não encontrado' };
    if (this.currentPlayer().id === playerId) return { error: 'Já é sua vez' };
    const hand = this.cm.getHand(playerId);
    const card = hand.find(c => c.id === cardId);
    if (!card) return { error: 'Carta não encontrada' };
    const top = this.topCard();
    if (!top) return { error: 'Sem carta no descarte' };
    if (card.value !== top.value || card.color !== top.color) return { error: 'Jump-In requer carta idêntica' };

    try { this.cm.play(playerId, cardId); } catch(e) { return { error: e.message }; }

    const gi = this.players.findIndex(p => p.id === playerId);
    if (gi !== -1) this.currentPlayerIndex = gi;
    if (card.color !== 'wild') this.currentColor = card.color;

    if (!this.cm.getHand(playerId).length) {
      this.gameOver = true; this.winner = player;
      this._validate('jumpIn:win');
      return { played: card, effect: 'win', gameOver: true, winner: player, jumpIn: true, state: this.getState() };
    }

    const eff = this._applyCardEffect(card, player);
    this._validate('jumpIn');
    return {
      played: card, effect: eff.effect, jumpIn: true,
      needsColor: eff.needsColor || false,
      colorAdvance: eff._colorAdvance || { skip: false },
      state: this.getState(),
    };
  }

  // ─── Remoção de Jogador ──────────────────────────────────

  removePlayerFromGame(playerId) {
    this.cm.removePlayer(playerId);
    const gi = this.players.findIndex(p => p.id === playerId);
    if (gi !== -1) {
      if (this.currentPlayerIndex === gi)
        this.currentPlayerIndex = gi % Math.max(this.players.length - 1, 1);
      else if (this.currentPlayerIndex > gi)
        this.currentPlayerIndex--;
      this.players.splice(gi, 1);
    }
    if (this.playerOrder) this.playerOrder = this.playerOrder.filter(id => id !== playerId);
    this._validate('removePlayer');
  }

  // ─── Estado ─────────────────────────────────────────────

  getState() {
    const topCard = this.topCard();
    const current = this.currentPlayer();
    let playableIds = [];
    if (current && !this.gameOver) {
      if (this.pendingColorChoice || this.pendingTable9) {
        playableIds = [];
      } else if (this.pendingChain?.playerId === current.id) {
        playableIds = this.pendingChain.eligible;
      } else {
        playableIds = calcPlayableIds(
          this.cm.getHand(current.id), topCard, this.currentColor,
          this.pendingDraw, this.pendingWild4, this.rules
        );
      }
    }
    return {
      roomId: this.roomId, started: this.started, gameOver: this.gameOver,
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null,
      currentPlayerIndex: this.currentPlayerIndex,
      currentPlayerId:    current?.id ?? null,
      direction: this.direction, currentColor: this.currentColor, topCard,
      deckCount:    this.cm.deckCount,
      pendingDraw:  this.pendingDraw, pendingWild4: this.pendingWild4,
      pendingSwap:  this.pendingSwap ?? null,
      pendingTable9: this.pendingTable9
        ? { playerId: this.pendingTable9.playerId, hitters: Array.from(this.pendingTable9.hitters) }
        : null,
      pendingChain: this.pendingChain
        ? { playerId: this.pendingChain.playerId, value: this.pendingChain.value, eligible: this.pendingChain.eligible }
        : null,
      pendingColorChoice: this.pendingColorChoice
        ? { playerId: this.pendingColorChoice.playerId }
        : null,
      mustPlayCardId:  this.mustPlayCardId ?? null,
      playableCardIds: playableIds,
      turnCount:       this.turnCount,
      elapsedSeconds:  this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      rules:           this.rules,
      playerOrder:     this.playerOrder,
      players: this.players.map(p => ({
        id: p.id, name: p.name, avatar: p.avatar,
        cardCount:      this.cm.getHand(p.id).length,
        saidUno:        p.saidUno,
        drawnThisTurn:  p.drawnThisTurn,
        afkStrikes:     p.afkStrikes || 0,
      })),
    };
  }

  getPlayerState(playerId) { return { ...this.getState(), myHand: this.cm.getHand(playerId) }; }

  hasStackableCard(playerId) {
    if (!this.pendingDraw) return false;
    return this.cm.getHand(playerId).some(c => canStack(c, this.pendingDraw, this.pendingWild4, this.rules));
  }

  getPlayableIdsFor(playerId) {
    if (!this._getPlayer(playerId) || this.currentPlayer()?.id !== playerId) return [];
    if (this.pendingColorChoice) return [];
    if (this.mustPlayCardId) return [this.mustPlayCardId];
    if (this.pendingChain?.playerId === playerId) return this.pendingChain.eligible;
    return calcPlayableIds(this.cm.getHand(playerId), this.topCard(), this.currentColor, this.pendingDraw, this.pendingWild4, this.rules);
  }

  getHand(playerId) { return this.cm.getHand(playerId); }
}

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { UnoGame, canPlay, canStack, calcPlayableIds, COLORS, NUMERICS };
