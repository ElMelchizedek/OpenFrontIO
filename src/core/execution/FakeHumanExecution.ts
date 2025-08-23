import {
  Cell,
  Difficulty,
  Execution,
  Game,
  Gold,
  Nation,
  Player,
  PlayerID,
  PlayerType,
  Relation,
  TerrainType,
  Tick,
  Unit,
  UnitType,
} from "../game/Game";
import { TileRef, euclDistFN, manhattanDistFN } from "../game/GameMap";
import { calculateBoundingBox, flattenedEmojiTable, simpleHash } from "../Util";
import { BotBehavior } from "./utils/BotBehavior";
import { ConstructionExecution } from "./ConstructionExecution";
import { EmojiExecution } from "./EmojiExecution";
import { GameID } from "../Schemas";
import { NukeExecution } from "./NukeExecution";
import { PseudoRandom } from "../PseudoRandom";
import { SpawnExecution } from "./SpawnExecution";
import { TransportShipExecution } from "./TransportShipExecution";
import { closestTwoTiles } from "./Util";

export class FakeHumanExecution implements Execution {
  private active = true;
  private readonly random: PseudoRandom;
  private behavior: BotBehavior | null = null;
  private mg: Game;
  private player: Player | null = null;

  private readonly attackRate: number;
  private readonly attackTick: number;
  private readonly triggerRatio: number;
  private readonly reserveRatio: number;
  private readonly expandRatio: number;

  private readonly lastEmojiSent = new Map<Player, Tick>();
  private readonly lastNukeSent: [Tick, TileRef][] = [];
  private readonly embargoMalusApplied = new Set<PlayerID>();
  private readonly heckleEmoji: number[];

  constructor(
    gameID: GameID,
    private readonly nation: Nation,
  ) {
    this.random = new PseudoRandom(
      simpleHash(nation.playerInfo.id) + simpleHash(gameID),
    );
    this.attackRate = this.random.nextInt(40, 80);
    this.attackTick = this.random.nextInt(0, this.attackRate);
    this.triggerRatio = this.random.nextInt(60, 90) / 100;
    this.reserveRatio = this.random.nextInt(30, 60) / 100;
    this.expandRatio = this.random.nextInt(15, 25) / 100;
    this.heckleEmoji = ["🤡", "😡"].map((e) => flattenedEmojiTable.indexOf(e));
  }

  init(mg: Game) {
    this.mg = mg;
    if (this.random.chance(10)) {
      // this.isTraitor = true
    }
  }

  private updateRelationsFromEmbargos() {
    const { player } = this;
    if (player === null) return;
    const others = this.mg.players().filter((p) => p.id() !== player.id());

    others.forEach((other: Player) => {
      const embargoMalus = -20;
      if (
        other.hasEmbargoAgainst(player) &&
        !this.embargoMalusApplied.has(other.id())
      ) {
        player.updateRelation(other, embargoMalus);
        this.embargoMalusApplied.add(other.id());
      } else if (
        !other.hasEmbargoAgainst(player) &&
        this.embargoMalusApplied.has(other.id())
      ) {
        player.updateRelation(other, -embargoMalus);
        this.embargoMalusApplied.delete(other.id());
      }
    });
  }

  private handleEmbargoesToHostileNations() {
    const { player } = this;
    if (player === null) return;
    const others = this.mg.players().filter((p) => p.id() !== player.id());

    others.forEach((other: Player) => {
      /* When player is hostile starts embargo. Do not stop until neutral again */
      if (
        player.relation(other) <= Relation.Hostile &&
        !player.hasEmbargoAgainst(other) &&
        !player.isOnSameTeam(other)
      ) {
        player.addEmbargo(other, false);
      } else if (
        player.relation(other) >= Relation.Neutral &&
        player.hasEmbargoAgainst(other)
      ) {
        player.stopEmbargo(other);
      }
    });
  }

  tick(ticks: number) {
    if (ticks % this.attackRate !== this.attackTick) return;

    if (this.mg.inSpawnPhase()) {
      const rl = this.randomLand();
      if (rl === null) {
        console.warn(`cannot spawn ${this.nation.playerInfo.name}`);
        return;
      }
      this.mg.addExecution(new SpawnExecution(this.nation.playerInfo, rl));
      return;
    }

    if (this.player === null) {
      this.player =
        this.mg.players().find((p) => p.id() === this.nation.playerInfo.id) ??
        null;
      if (this.player === null) {
        return;
      }
    }

    if (!this.player.isAlive()) {
      this.active = false;
      return;
    }

    if (this.behavior === null) {
      // Player is unavailable during init()
      this.behavior = new BotBehavior(
        this.random,
        this.mg,
        this.player,
        this.triggerRatio,
        this.reserveRatio,
        this.expandRatio,
      );

      // Send an attack on the first tick
      this.behavior.sendAttack(this.mg.terraNullius());
      return;
    }

    this.behavior.attenuateFear();
    this.updateRelationsFromEmbargos();
    this.behavior.handleAllianceRequests();
    this.behavior.handleAllianceExtensionRequests();
    this.handleUnits();
    this.handleEmbargoesToHostileNations();
    this.maybeAttack();
  }

  private maybeAttack() {
    if (this.player === null || this.behavior === null) {
      throw new Error("not initialized");
    }
    const enemyborder = Array.from(this.player.borderTiles())
      .flatMap((t) => this.mg.neighbors(t))
      .filter(
        (t) =>
          this.mg.isLand(t) && this.mg.ownerID(t) !== this.player?.smallID(),
      );

    if (enemyborder.length === 0) {
      if (this.random.chance(10)) {
        this.sendBoatRandomly();
      }
      return;
    }
    if (this.random.chance(20)) {
      this.sendBoatRandomly();
      return;
    }

    const borderPlayers = enemyborder.map((t) =>
      this.mg.playerBySmallID(this.mg.ownerID(t)),
    );
    if (borderPlayers.some((o) => !o.isPlayer())) {
      this.behavior.sendAttack(this.mg.terraNullius());
      return;
    }

    const enemies = borderPlayers
      .filter((o) => o.isPlayer())
      .sort((a, b) => a.troops() - b.troops());

    // 5% chance to send a random alliance request
    if (this.random.chance(20)) {
      const toAlly = this.random.randElement(enemies);
      if (this.player.canSendAllianceRequest(toAlly)) {
        this.player.createAllianceRequest(toAlly);
        return;
      }
    }

    // 50-50 attack weakest player vs random player
    const toAttack = this.random.chance(2)
      ? enemies[0]
      : this.random.randElement(enemies);
    if (this.shouldAttack(toAttack)) {
      this.behavior.sendAttack(toAttack);
      return;
    }

    this.behavior.forgetOldEnemies();
    this.behavior.assistAllies();
    const enemy = this.behavior.selectEnemy();
    if (!enemy) return;
    this.maybeSendEmoji(enemy);
    this.maybeSendNuke(enemy);
    if (this.player.sharesBorderWith(enemy)) {
      this.behavior.sendAttack(enemy);
    } else {
      this.maybeSendBoatAttack(enemy);
    }
  }

  private shouldAttack(other: Player): boolean {
    if (this.player === null) throw new Error("not initialized");
    if (this.player.isOnSameTeam(other)) {
      return false;
    }
    if (this.player.isFriendly(other)) {
      if (this.shouldDiscourageAttack(other)) {
        return this.random.chance(200);
      }
      return this.random.chance(50);
    } else {
      if (this.shouldDiscourageAttack(other)) {
        return this.random.chance(4);
      }
      return true;
    }
  }

  private shouldDiscourageAttack(other: Player) {
    if (other.isTraitor()) {
      return false;
    }
    const { difficulty } = this.mg.config().gameConfig();
    if (
      difficulty === Difficulty.Hard ||
      difficulty === Difficulty.Impossible
    ) {
      return false;
    }
    if (other.type() !== PlayerType.Human) {
      return false;
    }
    // Only discourage attacks on Humans who are not traitors on easy or medium difficulty.
    return true;
  }

  private maybeSendEmoji(enemy: Player) {
    if (this.player === null) throw new Error("not initialized");
    if (enemy.type() !== PlayerType.Human) return;
    const lastSent = this.lastEmojiSent.get(enemy) ?? -300;
    if (this.mg.ticks() - lastSent <= 300) return;
    this.lastEmojiSent.set(enemy, this.mg.ticks());
    this.mg.addExecution(
      new EmojiExecution(
        this.player,
        enemy.id(),
        this.random.randElement(this.heckleEmoji),
      ),
    );
  }

  private maybeSendNuke(other: Player) {
    if (this.player === null) throw new Error("not initialized");
    const silos = this.player.units(UnitType.MissileSilo);
    if (
      silos.length === 0 ||
      this.player.gold() < this.cost(UnitType.AtomBomb) ||
      other.type() === PlayerType.Bot ||
      this.player.isOnSameTeam(other)
    ) {
      return;
    }

    const structures = other.units(
      UnitType.City,
      UnitType.DefensePost,
      UnitType.MissileSilo,
      UnitType.Port,
      UnitType.SAMLauncher,
    );
    const structureTiles = structures.map((u) => u.tile());
    const randomTiles: (TileRef | null)[] = new Array<TileRef | null>(10).fill(null);
    for (let i = 0; i < randomTiles.length; i++) {
      randomTiles[i] = this.randTerritoryTile(other);
    }
    const allTiles = randomTiles.concat(structureTiles);

    let bestTile: TileRef | null = null;
    let bestValue = 0;
    this.removeOldNukeEvents();
    outer: for (const tile of new Set(allTiles)) {
      if (tile === null) continue;
      for (const t of this.mg.bfs(tile, manhattanDistFN(tile, 15))) {
        // Make sure we nuke at least 15 tiles in border
        if (this.mg.owner(t) !== other) {
          continue outer;
        }
      }
      if (!this.player.canBuild(UnitType.AtomBomb, tile)) continue;
      const value = this.nukeTileScore(tile, silos, structures);
      if (value > bestValue) {
        bestTile = tile;
        bestValue = value;
      }
    }
    if (bestTile !== null) {
      this.sendNuke(bestTile);
    }
  }

  private removeOldNukeEvents() {
    const maxAge = 500;
    const tick = this.mg.ticks();
    while (
      this.lastNukeSent.length > 0 &&
      this.lastNukeSent[0][0] + maxAge < tick
    ) {
      this.lastNukeSent.shift();
    }
  }

  private sendNuke(tile: TileRef) {
    if (this.player === null) throw new Error("not initialized");
    const tick = this.mg.ticks();
    this.lastNukeSent.push([tick, tile]);
    this.mg.addExecution(
      new NukeExecution(UnitType.AtomBomb, this.player, tile),
    );
  }

  private nukeTileScore(tile: TileRef, silos: Unit[], targets: Unit[]): number {
    // Potential damage in a 25-tile radius
    const dist = euclDistFN(tile, 25, false);
    let tileValue = targets
      .filter((unit) => dist(this.mg, unit.tile()))
      .map((unit): number => {
        switch (unit.type()) {
          case UnitType.City:
            return 25_000;
          case UnitType.DefensePost:
            return 5_000;
          case UnitType.MissileSilo:
            return 50_000;
          case UnitType.Port:
            return 10_000;
          default:
            return 0;
        }
      })
      .reduce((prev, cur) => prev + cur, 0);

    // Avoid areas defended by SAM launchers
    const dist50 = euclDistFN(tile, 50, false);
    tileValue -=
      50_000 *
      targets.filter(
        (unit) =>
          unit.type() === UnitType.SAMLauncher && dist50(this.mg, unit.tile()),
      ).length;

    // Prefer tiles that are closer to a silo
    const siloTiles = silos.map((u) => u.tile());
    const result = closestTwoTiles(this.mg, siloTiles, [tile]);
    if (result === null) throw new Error("Missing result");
    const { x: closestSilo } = result;
    const distanceSquared = this.mg.euclideanDistSquared(tile, closestSilo);
    const distanceToClosestSilo = Math.sqrt(distanceSquared);
    tileValue -= distanceToClosestSilo * 30;

    // Don't target near recent targets
    tileValue -= this.lastNukeSent
      .filter(([_tick, tile]) => dist(this.mg, tile))
      .map((_) => 1_000_000)
      .reduce((prev, cur) => prev + cur, 0);

    return tileValue;
  }

  private maybeSendBoatAttack(other: Player) {
    if (this.player === null) throw new Error("not initialized");
    if (this.player.isOnSameTeam(other)) return;
    const closest = closestTwoTiles(
      this.mg,
      Array.from(this.player.borderTiles()).filter((t) =>
        this.mg.isOceanShore(t),
      ),
      Array.from(other.borderTiles()).filter((t) => this.mg.isOceanShore(t)),
    );
    if (closest === null) {
      return;
    }
    this.mg.addExecution(
      new TransportShipExecution(
        this.player,
        other.id(),
        closest.y,
        this.player.troops() / 5,
        null,
      ),
    );
  }

  private handleUnits() {
    return (
      this.maybeSpawnStructure(UnitType.City) ||
      this.maybeSpawnStructure(UnitType.Port) ||
      this.maybeSpawnWarship() ||
      this.maybeSpawnStructure(UnitType.Factory) ||
      this.maybeSpawnStructure(UnitType.MissileSilo) ||
      this.maybeSpawnStructure(UnitType.DefensePost)
    );
  }

  private maybeSpawnStructure(type: UnitType): boolean {
    if (this.player === null) throw new Error("not initialized");
    const owned = this.player.unitsOwned(type);
    let perceivedCostMultiplier = Math.min(owned + 1, 5);
    const realCost = this.cost(type);
    // If it's defence post, increment the multiplier to reflect the belief that building too many defence posts
    // is detrimental to the nation's economy.
    // NOTE: There's probably a better additive to choose.
    if (type === UnitType.DefensePost) { perceivedCostMultiplier++; }
    const perceivedCost = realCost * BigInt(perceivedCostMultiplier);
    if (this.player.gold() < perceivedCost) {
      return false;
    }

    const tile = this.structureSpawnTile(type);
    if (tile === null) {
      return false;
    }

    const canBuild = this.player.canBuild(type, tile);
    if (canBuild === false) {
      return false;
    }
    // Makes it so that we will only allow nations to build defence posts very rarely, unless they are being attacked
    // enough so that it warrants putting defence front and centre in their minds.
    if (type === UnitType.DefensePost && this.behavior) {
      if (this.player.getFear() < 50) return false;
    }

    this.mg.addExecution(new ConstructionExecution(this.player, type, tile));
    return true;
  }

  private structureSpawnTile(type: UnitType): TileRef | null {
    if (this.player === null) throw new Error("not initialized");

    let tiles: number[] = [];
    const enemies: Player[] = [];
    if (type === UnitType.Port) {
      tiles = Array.from(this.player.borderTiles()).filter((t) =>
        this.mg.isOceanShore(t));
    } else if (type === UnitType.DefensePost) {
      // Finds the enemies of the nation.
      for (const relation of this.player.allRelationsSorted()) {
        if (relation.relation < 50) enemies.push(relation.player);
      }
      // Sorts all tiles based on which player they are closest to.
      const all_tiles = this.player.tiles();
      type TileByPlayer = {
        tile: TileRef;
        player: Player;
      };
      const sorted_tiles: TileByPlayer[] = [];
      for (const tile of all_tiles) {
        let closest_neighbour: Player | undefined;
        let closest_distance = Infinity;
        for (const neighbour of this.player.neighbors()) {
          if (neighbour.isPlayer()) {
            const tiles_neighbour = Array.from(neighbour.tiles());
            // We'll assess the distance by comparing the selected tile to a random tile of
            // the neighbour in question.
            const distance = this.mg.manhattanDist(
              tile, tiles_neighbour[Math.floor(Math.random() * tiles_neighbour.length)]);
            if (distance < closest_distance) {
              closest_distance = distance;
              closest_neighbour = neighbour;
            }
          }
        }
        if (closest_neighbour?.isPlayer()) {
          const next_tile: TileByPlayer = {
            player: closest_neighbour,
            tile,
          };
          sorted_tiles.push(next_tile);
        }
      }
      tiles = Array.from(sorted_tiles.filter(
        (element) => enemies.includes(element.player)).map(
        (element) => element.tile,
      ));
    }
    if (tiles.length === 0) return null;
    const valueFunction = this.structureSpawnTileValue(type);
    let bestTile: TileRef | null = null;
    let bestValue = 0;
    const sampledTiles = this.arraySampler(tiles);
    for (const t of sampledTiles) {
      const v = valueFunction(t);
      if (v === -Infinity) return null;
      if (v <= bestValue && bestTile !== null) continue;
      if (!this.player.canBuild(type, t)) continue;
      // Found a better tile
      bestTile = t;
      bestValue = v;
    }
    return bestTile;
  }

  private * arraySampler<T>(a: T[], sampleSize = 50): Generator<T> {
    if (a.length <= sampleSize) {
      // Return all elements
      yield* a;
    } else {
      // Sample `sampleSize` elements
      const remaining = new Set<T>(a);
      while (sampleSize--) {
        const t = this.random.randFromSet(remaining);
        remaining.delete(t);
        yield t;
      }
    }
  }

  private structureSpawnTileValue(type: UnitType): (tile: TileRef) => number {
    if (this.player === null) throw new Error("not initialized");
    const borderTiles = this.player.borderTiles();
    const { mg } = this;
    const otherUnits = this.player.units(type);
    // Prefer spacing structures out of atom bomb range
    const borderSpacing = this.mg.config().nukeMagnitudes(UnitType.AtomBomb).outer;
    const structureSpacing = borderSpacing * 2;

    // Prefer to be far away from other structures of the same type
    function spaceStructures(tile: number, w: number) {
      const otherTiles: Set<TileRef> = new Set(otherUnits.map((u) => u.tile()));
      otherTiles.delete(tile);
      const closestOther = closestTwoTiles(mg, otherTiles, [tile]);
      if (closestOther !== null) {
        const d = mg.manhattanDist(closestOther.x, tile);
        w += Math.min(d, structureSpacing);
      }
      return w;
    }

    switch (type) {
      case UnitType.Port:
        return (tile) => {
          let w = 0;
          w = spaceStructures(tile, w);

          return w;
        };
      case UnitType.City:
      case UnitType.Factory:
      case UnitType.MissileSilo:
        return (tile) => {
          let w = 0;

          // Prefer higher elevations
          w += mg.magnitude(tile);

          // Prefer to be away from the border
          const closestBorder = closestTwoTiles(mg, borderTiles, [tile]);
          if (closestBorder !== null) {
            const d = mg.manhattanDist(closestBorder.x, tile);
            w += Math.min(d, borderSpacing);
          }

          w = spaceStructures(tile, w);
          // TODO: Cities and factories should consider train range limits
          return w;
        };
      case UnitType.DefensePost:
        return (tile) => {
          if (this.player === null) throw new Error("not initialized");

          let w = 0;

          // Generate subset of randomly chosen border tiles, and then filter it so that only those on the border
          // with an "enemy" remain. If none of the border tiles are next to an enemy, we can safely assume there's
          // none, and abort the whole process.
          const random_border_tiles: ReadonlySet<TileRef> = new Set(this.arraySampler(Array.from(borderTiles)));
          const enemy_random_border_tiles: Set<TileRef> = new Set();
          for (const tile of random_border_tiles) {
            const owner = mg.owner(tile);
            if (!owner.isPlayer() || owner.id() === null) continue;
            if (mg.player(owner.id()).type() === PlayerType.Bot) continue;

            const enemies = mg.neighbors(tile).filter((tile) => {
              const owner_neighbour = mg.owner(tile);
              if (owner_neighbour === this.player) return false;
              const relation = this.player?.relation(<Player>mg.owner(tile));
              return relation !== undefined && relation <= 0;
            });
            if (enemies.length !== 0) enemy_random_border_tiles.add(tile);
          }
          if (enemy_random_border_tiles.size === 0) return -Infinity;
          // Now we check to see if the tile in question is within an atom bomb's distance of these sampled
          // border tiles. If it isn't, we abort.
          let within_threshold = false;
          for (const border_tile of random_border_tiles) {
            const border_cell = mg.cell(border_tile);
            const certain_cell = mg.cell(tile);

            const distance_vector = [border_cell.x - certain_cell.x, border_cell.y - certain_cell.y];
            const distance_magnitude = Math.sqrt(distance_vector[0] ** 2 + distance_vector[1] ** 2);
            within_threshold = distance_magnitude <= structureSpacing;
          }
          if (!within_threshold) return 0;

          // Prefer to be as high as possible in elevation.
          w += mg.magnitude(tile);

          // Prefer to be away from other structures of the same type
          w = spaceStructures(tile, w);

          return w;
        };
      case UnitType.DefensePost:
        return (tile) => {
          if (this.player === null) throw new Error("not initialized");

          let w = 0;

          // Prefer to be as high as possible in elevation.
          w += mg.magnitude(tile);

          for (const certain_tile of borderTiles) {
            const distance = this.mg.manhattanDist(certain_tile, tile);
            if (distance <= borderSpacing) w = distance;
          }

          return w;
        };
      default:
        throw new Error(`Value function not implemented for ${type}`);
    }
  }

  private maybeSpawnWarship(): boolean {
    if (this.player === null) throw new Error("not initialized");
    if (!this.random.chance(50)) {
      return false;
    }
    const ports = this.player.units(UnitType.Port);
    const ships = this.player.units(UnitType.Warship);
    if (
      ports.length > 0 &&
      ships.length === 0 &&
      this.player.gold() > this.cost(UnitType.Warship)
    ) {
      const port = this.random.randElement(ports);
      const targetTile = this.warshipSpawnTile(port.tile());
      if (targetTile === null) {
        return false;
      }
      const canBuild = this.player.canBuild(UnitType.Warship, targetTile);
      if (canBuild === false) {
        console.warn("cannot spawn destroyer");
        return false;
      }
      this.mg.addExecution(
        new ConstructionExecution(this.player, UnitType.Warship, targetTile),
      );
      return true;
    }
    return false;
  }

  private randTerritoryTile(p: Player): TileRef | null {
    const boundingBox = calculateBoundingBox(this.mg, p.borderTiles());
    for (let i = 0; i < 100; i++) {
      const randX = this.random.nextInt(boundingBox.min.x, boundingBox.max.x);
      const randY = this.random.nextInt(boundingBox.min.y, boundingBox.max.y);
      if (!this.mg.isOnMap(new Cell(randX, randY))) {
        // Sanity check should never happen
        continue;
      }
      const randTile = this.mg.ref(randX, randY);
      if (this.mg.owner(randTile) === p) {
        return randTile;
      }
    }
    return null;
  }

  private warshipSpawnTile(portTile: TileRef): TileRef | null {
    const radius = 250;
    for (let attempts = 0; attempts < 50; attempts++) {
      const randX = this.random.nextInt(
        this.mg.x(portTile) - radius,
        this.mg.x(portTile) + radius,
      );
      const randY = this.random.nextInt(
        this.mg.y(portTile) - radius,
        this.mg.y(portTile) + radius,
      );
      if (!this.mg.isValidCoord(randX, randY)) {
        continue;
      }
      const tile = this.mg.ref(randX, randY);
      // Sanity check
      if (!this.mg.isOcean(tile)) {
        continue;
      }
      return tile;
    }
    return null;
  }

  private cost(type: UnitType): Gold {
    if (this.player === null) throw new Error("not initialized");
    return this.mg.unitInfo(type).cost(this.player);
  }

  sendBoatRandomly() {
    if (this.player === null) throw new Error("not initialized");
    const oceanShore = Array.from(this.player.borderTiles()).filter((t) =>
      this.mg.isOceanShore(t),
    );
    if (oceanShore.length === 0) {
      return;
    }

    const src = this.random.randElement(oceanShore);

    const dst = this.randomBoatTarget(src, 150);
    if (dst === null) {
      return;
    }

    this.mg.addExecution(
      new TransportShipExecution(
        this.player,
        this.mg.owner(dst).id(),
        dst,
        this.player.troops() / 5,
        null,
      ),
    );
    return;
  }

  randomLand(): TileRef | null {
    const delta = 25;
    let tries = 0;
    while (tries < 50) {
      tries++;
      const cell = this.nation.spawnCell;
      const x = this.random.nextInt(cell.x - delta, cell.x + delta);
      const y = this.random.nextInt(cell.y - delta, cell.y + delta);
      if (!this.mg.isValidCoord(x, y)) {
        continue;
      }
      const tile = this.mg.ref(x, y);
      if (this.mg.isLand(tile) && !this.mg.hasOwner(tile)) {
        if (
          this.mg.terrainType(tile) === TerrainType.Mountain &&
          this.random.chance(2)
        ) {
          continue;
        }
        return tile;
      }
    }
    return null;
  }

  private randomBoatTarget(tile: TileRef, dist: number): TileRef | null {
    if (this.player === null) throw new Error("not initialized");
    const x = this.mg.x(tile);
    const y = this.mg.y(tile);
    for (let i = 0; i < 500; i++) {
      const randX = this.random.nextInt(x - dist, x + dist);
      const randY = this.random.nextInt(y - dist, y + dist);
      if (!this.mg.isValidCoord(randX, randY)) {
        continue;
      }
      const randTile = this.mg.ref(randX, randY);
      if (!this.mg.isLand(randTile)) {
        continue;
      }
      const owner = this.mg.owner(randTile);
      if (!owner.isPlayer()) {
        return randTile;
      }
      if (!owner.isFriendly(this.player)) {
        return randTile;
      }
    }
    return null;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }
}
