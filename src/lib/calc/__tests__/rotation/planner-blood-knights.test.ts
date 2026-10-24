import { it, expect } from 'vitest';
import fixture from '../fixtures/blood-knights-latest.json';
import { attachGearPerks } from '$lib/data/perks';
import { ARMOUR } from '$lib/data/armour';
import { ABILITIES } from '$lib/data/abilities';
import { SETTINGS } from '../../settings_rb';
import { calculateRotationDamageCore } from '../../rotation_builder/rotation-damage-calculator';
import { searchRotations, plannerAbilities } from '../../planner/planner';
it('searches the export with arrow stacks and replays the returned plan exactly', async () => {
    const bar = (entries: any) => Object.assign(Array(300).fill(null), structuredClone(entries));
    const rotation = {
        abilityBar: bar(fixture.abilities),
        extraActionBar: bar(fixture.extraActions),
        nulledTicks: Array(300).fill(false),
        targetCounts: bar(fixture.targetCounts),
        tickEvents: bar(fixture.tickEvents),
        stalledAbilities: bar(fixture.stalledAbilities),
        releasedAbilities: bar(fixture.releasedAbilities)
    };
    const settings: any = {
        ...fixture.settings,
        [SETTINGS.CALC_TYPE]: SETTINGS.CALC_TYPE_VALUES.ROTATION,
        _combatStyle: 'ranged'
    };
    attachGearPerks(settings, new Map());
    const available = plannerAbilities(settings, ['ranged']);
    expect(available).toContain(ABILITIES.IMBUE_SHADOWS);
    const result = await searchRotations({
        settings,
        rotation,
        abilities: [ABILITIES.PIERCING_SHOT, ABILITIES.GREATER_RICOCHET, ABILITIES.IMBUE_SHADOWS],
        ammo: [ARMOUR.WEN_ARROWS, ARMOUR.FUL_ARROWS],
        start: 20,
        end: 60,
        objective: 'damage',
        goal: 700000,
        scope: 'all',
        iterations: 5,
        seconds: 20,
        seed: 42
    });
    expect(result.best?.valid).toBe(true);
    const replay = calculateRotationDamageCore(settings, result.best!.rotation, 60);
    expect(replay.impactDamagePerTick!.slice(20, 60).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(
        result.best!.damage,
        5
    );
    const total =
        replay.regularDamage +
        replay.poisonDamage +
        replay.familiarDamage +
        replay.dreadnipDamage +
        replay.conjureDamage +
        Object.values(replay.secondaryDamage ?? {}).reduce((a, b) => a + b, 0);
    expect(replay.impactDamagePerTick!.reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(total, 5);
    const brid = await searchRotations({
        settings,
        rotation,
        abilities: [ABILITIES.PIERCING_SHOT, ABILITIES.BERSERK, ABILITIES.MELEE_AUTO],
        ammo: [],
        start: 20,
        end: 60,
        objective: 'damage',
        goal: 700000,
        scope: 'all',
        iterations: 10,
        seconds: 15,
        seed: 42,
        stayInBurst: true,
        stackDetours: true
    });
    expect(brid.best?.valid).toBe(true);
    console.info(
        'Planner Blood Knights trials',
        result.trials,
        'elapsed',
        result.elapsed,
        'damage',
        result.best!.damage
    );
}, 30000);
