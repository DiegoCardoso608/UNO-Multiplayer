// ============================================================
//  CARD MANAGER — UNO
//  Inventário centralizado de cartas.
//  NINGUÉM mexe em cartas fora daqui.
//
//  Regra de Ouro:
//    deck + discardPile + sum(hands) === TOTAL_CARDS (108)
//
//  Uso:
//    const cm = new CardManager();
//    cm.deal(playerId, 7);
//    cm.play(playerId, cardId);
//    cm.draw(playerId, 1);
//    cm.validate();  // lança ou loga erro se corrompido
// ============================================================

'use strict';

const COLORS      = ['red', 'green', 'blue', 'yellow'];
const VALUES      = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
const WILD_VALUES = ['wild', 'wild4'];
const TOTAL_CARDS = 108;

function buildFullDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (const value of VALUES) {
      deck.push({ color, value, id: `${color}_${value}_a` });
      if (value !== '0') deck.push({ color, value, id: `${color}_${value}_b` });
    }
  }
  for (const value of WILD_VALUES) {
    for (let i = 0; i < 4; i++) {
      deck.push({ color: 'wild', value, id: `${value}_${i}` });
    }
  }
  if (deck.length !== TOTAL_CARDS) {
    throw new Error(`[CardManager] Deck inválido: ${deck.length} cartas (esperado ${TOTAL_CARDS})`);
  }
  return deck;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class CardManager {
  constructor() {
    // Inventário global
    this.deck        = [];   // cartas no baralho (topo = index 0)
    this.discardPile = [];   // pilha de descarte (topo = último elemento)
    this.hands       = new Map(); // playerId → Card[]

    // Log de auditoria (últimas 20 operações)
    this._auditLog = [];

    // Modo deck infinito: gera cartas novas quando o deck esgota
    this.infiniteMode = false;
  }

  // ─── Setup ────────────────────────────────────────────────

  /** Cria e embaralha o baralho completo. */
  init() {
    this.deck        = shuffleArray(buildFullDeck());
    this.discardPile = [];
    this.hands       = new Map();
    this._log('init', { deckSize: this.deck.length });
  }

  /** Registra um jogador (cria mão vazia). */
  addPlayer(playerId) {
    if (!this.hands.has(playerId)) {
      this.hands.set(playerId, []);
    }
  }

  /** Remove jogador e devolve cartas ao deck (embaralhado). */
  removePlayer(playerId) {
    const hand = this.hands.get(playerId) || [];
    this.hands.delete(playerId);
    if (hand.length > 0) {
      this.deck.push(...hand);
      this.deck = shuffleArray(this.deck);
      this._log('removePlayer', { playerId, returned: hand.length });
    }
  }

  // ─── Operações Principais ─────────────────────────────────

  /**
   * Distribui `count` cartas do deck para o jogador.
   * @returns {Card[]} cartas distribuídas
   */
  deal(playerId, count) {
    this._ensurePlayer(playerId);
    const drawn = this._drawFromDeck(count);
    const hand  = this.hands.get(playerId);
    hand.push(...drawn);
    this._log('deal', { playerId, count: drawn.length });
    return drawn;
  }

  /**
   * Jogador compra `count` cartas (mesmo que deal, semântica diferente).
   * @returns {Card[]} cartas compradas
   */
  draw(playerId, count = 1) {
    this._ensurePlayer(playerId);
    const drawn = this._drawFromDeck(count);
    const hand  = this.hands.get(playerId);
    hand.push(...drawn);
    this._log('draw', { playerId, count: drawn.length, cardIds: drawn.map(c => c.id) });
    return drawn;
  }

  /**
   * Jogador joga uma carta — remove da mão e coloca no descarte.
   * @returns {Card} a carta jogada
   * @throws se carta não for encontrada na mão
   */
  play(playerId, cardId) {
    this._ensurePlayer(playerId);
    const hand = this.hands.get(playerId);
    const idx  = hand.findIndex(c => c.id === cardId);
    if (idx === -1) {
      throw new Error(`[CardManager] Carta ${cardId} não encontrada na mão de ${playerId}`);
    }
    const [card] = hand.splice(idx, 1);
    this.discardPile.push(card);
    this._log('play', { playerId, cardId, remaining: hand.length });
    return card;
  }

  /**
   * Troca as mãos entre dois jogadores (Regra do 7).
   */
  swapHands(playerA, playerB) {
    this._ensurePlayer(playerA);
    this._ensurePlayer(playerB);
    const handA = this.hands.get(playerA);
    const handB = this.hands.get(playerB);
    this.hands.set(playerA, handB);
    this.hands.set(playerB, handA);
    this._log('swapHands', { playerA, playerB, countA: handB.length, countB: handA.length });
  }

  /**
   * Rotaciona todas as mãos na direção indicada (Regra do 0).
   * @param {string[]} playerOrder - array de playerIds em ordem de turno
   * @param {number} direction - 1 (horário) ou -1 (anti-horário)
   */
  rotateHands(playerOrder, direction) {
    if (playerOrder.length < 2) return;
    const hands = playerOrder.map(id => this.hands.get(id) || []);
    let rotated;
    if (direction === 1) {
      // Horário: último recebe do penúltimo... primeiro recebe do último
      rotated = [hands[hands.length - 1], ...hands.slice(0, -1)];
    } else {
      // Anti-horário: primeiro recebe do segundo...
      rotated = [...hands.slice(1), hands[0]];
    }
    playerOrder.forEach((id, i) => this.hands.set(id, rotated[i]));
    this._log('rotateHands', { direction, players: playerOrder.length });
  }

  // ─── Consultas ────────────────────────────────────────────

  /** Retorna a mão de um jogador (cópia). */
  getHand(playerId) {
    return [...(this.hands.get(playerId) || [])];
  }

  /** Retorna a carta no topo do descarte. */
  topCard() {
    return this.discardPile.length > 0
      ? this.discardPile[this.discardPile.length - 1]
      : null;
  }

  /** Quantidade de cartas no deck. */
  get deckCount() {
    return this.deck.length;
  }

  // ─── Auditoria ────────────────────────────────────────────

  /**
   * Valida integridade do inventário.
   * @param {object} options
   * @param {boolean} options.throw - se true, lança erro; se false, apenas loga
   * @returns {{ valid: boolean, errors: string[], total: number }}
   */
  validate({ throw: shouldThrow = false } = {}) {
    const errors = [];

    // 1. Soma total (só valida em modo normal)
    let total = this.deck.length + this.discardPile.length;
    for (const hand of this.hands.values()) total += hand.length;

    if (!this.infiniteMode && total !== TOTAL_CARDS) {
      errors.push(`Total de cartas: ${total} (esperado ${TOTAL_CARDS})`);
    }

    // 2. IDs duplicados
    const seen = new Set();
    const allCards = [
      ...this.deck,
      ...this.discardPile,
      ...[...this.hands.values()].flat(),
    ];
    for (const card of allCards) {
      if (seen.has(card.id)) {
        errors.push(`ID duplicado: ${card.id}`);
      }
      seen.add(card.id);
    }

    // 3. Cartas sem ID
    const noId = allCards.filter(c => !c.id);
    if (noId.length > 0) {
      errors.push(`${noId.length} carta(s) sem ID`);
    }

    if (errors.length > 0) {
      const msg = `[CardManager] Auditoria falhou:\n  ${errors.join('\n  ')}`;
      console.error(msg);
      this._log('validate:FAIL', { errors, total });
      if (shouldThrow) throw new Error(msg);
    } else {
      this._log('validate:OK', { total });
    }

    return { valid: errors.length === 0, errors, total };
  }

  /**
   * Tenta auto-corrigir problemas simples (cartas duplicadas / perdidas).
   * Usado como fallback em produção para não travar o jogo.
   */
  autoRepair() {
    const seen    = new Set();
    const dupes   = [];

    // Remove duplicatas — mantém a primeira ocorrência
    const clean = (arr) => arr.filter(c => {
      if (seen.has(c.id)) { dupes.push(c.id); return false; }
      seen.add(c.id); return true;
    });

    this.deck        = clean(this.deck);
    this.discardPile = clean(this.discardPile);
    for (const [pid, hand] of this.hands) {
      this.hands.set(pid, clean(hand));
    }

    // Reinsere cartas perdidas
    const allIds = new Set(buildFullDeck().map(c => c.id));
    const missing = [...allIds].filter(id => !seen.has(id));
    if (missing.length > 0) {
      const missingCards = buildFullDeck().filter(c => missing.includes(c.id));
      this.deck.push(...missingCards);
      this.deck = shuffleArray(this.deck);
    }

    this._log('autoRepair', { dupes: dupes.length, missing: missing.length });
    console.warn(`[CardManager] autoRepair: ${dupes.length} dupl., ${missing.length} perdidas`);
  }

  // ─── Serialização (para getState) ─────────────────────────

  /**
   * Snapshot do inventário para debug/logs (não envia ao cliente).
   */
  snapshot() {
    const handsObj = {};
    for (const [pid, hand] of this.hands) {
      handsObj[pid] = hand.length;
    }
    return {
      deckCount:    this.deck.length,
      discardCount: this.discardPile.length,
      hands:        handsObj,
    };
  }

  // ─── Privados ─────────────────────────────────────────────

  _ensurePlayer(playerId) {
    if (!this.hands.has(playerId)) {
      this.hands.set(playerId, []);
    }
  }

  _drawFromDeck(count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) {
        if (this.infiniteMode) {
          this.generateInfiniteCards(20);
        } else {
          this._recycleDeck();
        }
      }
      if (this.deck.length === 0) break;
      drawn.push(this.deck.shift());
    }
    return drawn;
  }

  _recycleDeck() {
    if (this.discardPile.length <= 1) return;
    const top  = this.discardPile.pop();
    // Reseta cor das cartas coringa que voltam ao deck
    const recycled = this.discardPile.map(c =>
      c.color === 'wild' ? { ...c } : c
    );
    this.deck        = shuffleArray(recycled);
    this.discardPile = [top];
    this._log('recycleDeck', { recycled: this.deck.length });
  }

  generateInfiniteCards(count = 20) {
    const pool   = shuffleArray(buildFullDeck());
    const extras = pool.slice(0, count).map((c, i) => ({
      ...c,
      id: c.id + '_inf_' + Date.now() + '_' + i,
    }));
    this.deck.push(...extras);
    this._log('generateInfinite', { count: extras.length });
  }

  _log(op, data = {}) {
    this._auditLog.push({ op, ts: Date.now(), ...data });
    if (this._auditLog.length > 20) this._auditLog.shift();
  }
}

module.exports = { CardManager, TOTAL_CARDS, COLORS, buildFullDeck };
