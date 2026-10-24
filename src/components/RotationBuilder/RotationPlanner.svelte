<script lang="ts">
    import { onDestroy, tick as nextRender } from 'svelte';
    import { phaseStackOptions } from '$lib/calc/rotation_builder/phaseStacks';
    import { normalizeTickEvent } from '$lib/calc/rotation_builder/tickEvents';
    import { MAX_ROTATION_TICKS } from '$lib/calc/planner/limits';
    import { SETTINGS } from '$lib/calc/settings_rb';
    import {
        addPreparation,
        damageShare,
        resetPreparationResources
    } from '$lib/calc/planner/encounter';
    import { abils } from '$lib/data/abilities';
    import { getEquipment, equipment } from '$lib/data/equipment';
    import { bossPresets } from '$lib/data/bosses/boss_presets';
    import { attachGearPerks } from '$lib/data/perks';
    import {
        plannerAbilities,
        equipmentAllows,
        type PlannerInput
    } from '$lib/calc/planner/planner';
    import { snapshotEditorCalculation } from '$lib/calc/rotation_builder/editorCalculation';
    import { resolveQuiverAmmo } from '$lib/calc/rotation_builder/quiver';
    import { rotationActions } from '$lib/stores/rotationStore.svelte.js';
    let { refreshUI } = $props();
    let dialog = $state<HTMLDialogElement>();
    let open = $state(false),
        step = $state(0),
        running = $state(false),
        error = $state(''),
        applied = $state(false);
    let snapshot: any = $state.raw(null),
        original: any,
        fingerprint = '';
    let request = $state.raw<PlannerInput>();
    let result: any = $state.raw(null),
        worker: Worker | undefined;
    let mode = $state(1),
        stayInBurst = $state(true),
        stackDetours = $state(true);
    let phases = $state<any[]>([]);
    let team = $state(false),
        dealers = $state(2),
        extras = $state(0),
        extraContribution = $state(0);
    let autoDistance = $state(false),
        meleeOwner = $state(true),
        moveTicks = $state(3);
    let distances = $state([2, 3]);
    let prep = $state(false),
        warsTicks = $state(20),
        travelSeconds = $state(6),
        dummyTicks = $state(0);
    let dummyAvailable = $state(false);
    let prepTicks = $derived(
        prep ? warsTicks + Math.ceil(travelSeconds / 0.6) + (dummyAvailable ? dummyTicks : 0) : 0
    );
    let share = $derived(team ? 1 / Math.max(1, dealers + (extras * extraContribution) / 100) : 1);
    function addWars() {
        prep = true;
        start = 0;
    }
    let styles = $state(['ranged']),
        allowed = $state<string[]>([]),
        ammo = $state<number[]>([]);
    let settings: any = $state({});
    let objective = $state<'time' | 'damage'>('time'),
        goal = $state(700000),
        start = $state(0),
        ticks = $state(100);
    let scope = $state<'all' | 'main'>('all'),
        seconds = $state(30),
        search = $state(''),
        targets = $state(1);
    const styleLabels = [
        ['ranged', 'Ranged'],
        ['melee', 'Melee'],
        ['magic', 'Magic'],
        ['necromancy', 'Necromancy']
    ];
    let candidates = $derived(snapshot ? plannerAbilities(settings, styles) : []);
    let shown = $derived(
        candidates.filter((key) =>
            (abils[key].title ?? key).toLowerCase().includes(search.toLowerCase())
        )
    );
    let ammunition = $derived.by(() => {
        const weapon = getEquipment(
            settings[
                settings[SETTINGS.WEAPON_TYPE_RANGED] === 'two-hand'
                    ? SETTINGS.RANGED_TH
                    : SETTINGS.RANGED_MH
            ]
        );
        const kind = weapon?.type === 'crossbow' ? /bolts/i : /arrows/i;
        return Object.values(equipment)
            .filter((item) => item.slot === 'ammo' && kind.test(item.name))
            .sort((a, b) => a.name.localeCompare(b.name));
    });
    function chooseDefaults() {
        allowed = plannerAbilities(settings, styles).filter((key) =>
            equipmentAllows(key, settings, false)
        );
    }
    async function begin() {
        snapshot = snapshotEditorCalculation();
        original = rotationActions.getCurrentRotationData();
        fingerprint = JSON.stringify(original);
        settings = structuredClone(snapshot.settings);
        styles = [
            snapshot.style === 'necro'
                ? 'necromancy'
                : snapshot.style === 'defence'
                  ? 'ranged'
                  : snapshot.style
        ];
        mode = 1;
        prep = true;
        start = 0;
        autoDistance = false;
        phases = snapshot.rotation.tickEvents.flatMap((event: any, tick: number) =>
            event?.phase
                ? [
                      {
                          tick,
                          name: event.phase,
                          downtime: event.downtime ?? 0,
                          clearStacks: event.clearStacks ?? [],
                          damage: 0
                      }
                  ]
                : []
        );
        ammo = [];
        const current = resolveQuiverAmmo(settings);
        if (typeof current === 'number') ammo = [current];
        targets = Number(snapshot.rotation.targetCounts.find((n: any) => n != null) ?? 1);
        chooseDefaults();
        step = 0;
        error = '';
        result = null;
        applied = false;
        open = true;
        await nextRender();
        dialog.showModal();
    }
    function selectStyle(style: string, checked: boolean) {
        styles = checked ? [...styles, style] : styles.filter((s) => s !== style);
        chooseDefaults();
    }
    function setMode(value: number) {
        mode = value;
        styles = [
            ...styles,
            ...styleLabels.map(([key]) => key).filter((key) => !styles.includes(key))
        ].slice(0, mode);
        chooseDefaults();
    }
    function addPhase() {
        const tick = Math.min(
            MAX_ROTATION_TICKS - 1,
            phases.length ? Math.max(...phases.map((p) => p.tick)) + 30 : start
        );
        if (phases.some((p) => p.tick === tick)) return;
        phases = [
            ...phases,
            { tick, name: `Phase ${phases.length + 1}`, downtime: 0, clearStacks: [], damage: 0 }
        ];
    }
    function run() {
        error = '';
        result = null;
        applied = false;
        try {
            if (styles.length !== mode || !allowed.length)
                throw Error('Choose the requested number of loadouts and at least one ability.');
            if (
                !Number.isInteger(start) ||
                start < 0 ||
                (objective === 'damage' &&
                    (!Number.isInteger(ticks) || ticks < 1 || start + ticks > MAX_ROTATION_TICKS))
            )
                throw Error('Choose valid whole ticks within the timeline capacity.');
            const rotation = structuredClone(snapshot.rotation);
            if (
                phases.some(
                    (p) =>
                        !Number.isInteger(p.tick) ||
                        p.tick < 0 ||
                        p.tick >= MAX_ROTATION_TICKS ||
                        !p.name.trim()
                ) ||
                new Set(phases.map((p) => p.tick)).size !== phases.length
            )
                throw Error(
                    'Give each phase a name and a different start tick within the timeline capacity.'
                );
            for (let t = 0; t < rotation.tickEvents.length; t++)
                if (rotation.tickEvents[t]?.phase)
                    rotation.tickEvents[t] = normalizeTickEvent({
                        ...rotation.tickEvents[t],
                        phase: undefined,
                        clearStacks: undefined,
                        downtime: undefined
                    });
            const fraction = team ? damageShare(dealers, extras, extraContribution) : 1;
            let ordered = [...phases].sort((a, b) => a.tick - b.tick);
            let fightStart = start;
            if (prep) {
                if (start !== 0 || !Number.isFinite(travelSeconds) || travelSeconds < 0)
                    throw Error('Preparation starts at tick 0. Enter a non-negative travel time.');
                const setup = addPreparation(
                    rotation,
                    ordered,
                    warsTicks,
                    Math.ceil(travelSeconds / 0.6),
                    dummyAvailable ? dummyTicks : 0
                );
                ordered = setup.phases;
                fightStart = setup.fight;
            }
            const end =
                objective === 'time'
                    ? Math.min(
                          MAX_ROTATION_TICKS,
                          Math.max(fightStart + 100, ...ordered.map((p) => p.tick + 30))
                      )
                    : fightStart + ticks;
            if (end > MAX_ROTATION_TICKS) throw Error('Timeline capacity exceeded.');
            for (const p of ordered)
                rotation.tickEvents[p.tick] = normalizeTickEvent({
                    ...rotation.tickEvents[p.tick],
                    phase: p.name,
                    downtime: p.downtime,
                    clearStacks: p.clearStacks
                });
            rotation.targetCounts[fightStart] = targets;
            rotation.tickEvents[fightStart] = {
                ...rotation.tickEvents[fightStart],
                ...(autoDistance ? { ghraziAoeRole: meleeOwner } : {}),
                target: settings[SETTINGS.BOSS_PRESET],
                automaticAccuracy: settings[SETTINGS.AUTO_ACCURACY],
                accuracy: settings[SETTINGS.HIT_CHANCE],
                ghraziDistance: settings[SETTINGS.GHRAZI_DISTANCE]
            };
            const clean = JSON.parse(JSON.stringify(settings));
            if (prep || start === 0) resetPreparationResources(clean);
            if (prep) {
                clean[SETTINGS.BOSS_PATTERN_START] = fightStart;
                settings[SETTINGS.BOSS_PATTERN_START] = fightStart;
            }
            attachGearPerks(clean, new Map(snapshot.ownedGear));
            request = {
                settings: clean,
                rotation,
                abilities: allowed.filter((key) => candidates.includes(key)),
                ammo: styles.includes('ranged') ? [...ammo] : [],
                start,
                end,
                fightStart,
                zeroStartingResources: prep || start === 0,
                ...(prep
                    ? {
                          preparation: {
                              wars: warsTicks,
                              travel: Math.ceil(travelSeconds / 0.6),
                              dummy: dummyAvailable ? dummyTicks : 0
                          }
                      }
                    : {}),
                ...(autoDistance && /ghrazi/i.test(settings[SETTINGS.BOSS_PRESET] ?? '')
                    ? { positioning: { distances: [...distances], meleeOwner, moveTicks } }
                    : {}),
                objective,
                untilTarget: objective === 'time',
                goal: goal * fraction,
                scope,
                iterations: 10000,
                seconds,
                seed: Date.now() >>> 0,
                stayInBurst,
                stackDetours,
                phaseGoals: ordered.flatMap((p, i) =>
                    p.damage > 0 && p.tick < end && (ordered[i + 1]?.tick ?? end) > fightStart
                        ? [
                              {
                                  name: p.name,
                                  start: Math.max(fightStart, p.tick),
                                  end: Math.min(end, ordered[i + 1]?.tick ?? end),
                                  damage: p.damage * fraction
                              }
                          ]
                        : []
                )
            };
            worker?.terminate();
            const currentWorker = new Worker(
                new URL('../../lib/calc/planner/planner.worker.ts', import.meta.url),
                { type: 'module' }
            );
            worker = currentWorker;
            running = true;
            step = 3;
            currentWorker.onmessage = ({ data }) => {
                if (worker !== currentWorker) return;
                if (data.type === 'error') {
                    error = data.error;
                    running = false;
                    currentWorker.terminate();
                    worker = undefined;
                    return;
                }
                if (data.end) request = { ...request!, end: data.end };
                result = data;
                if (data.type === 'done') {
                    running = false;
                    currentWorker.terminate();
                    worker = undefined;
                }
            };
            currentWorker.onerror = () => {
                error =
                    'The planner could not run. Try a shorter window or fewer allowed abilities.';
                running = false;
                currentWorker.terminate();
                worker = undefined;
            };
            currentWorker.postMessage({ input: request });
        } catch (e: any) {
            error = e.message;
            running = false;
        }
    }
    function stop() {
        worker?.terminate();
        worker = undefined;
        running = false;
    }
    let displayEnd = $derived(
        result?.best && request?.objective === 'time' && result.best.reached !== null
            ? Math.min(request.end, request.start + result.best.reached + 1)
            : request?.end
    );
    function apply() {
        if (!result?.best || running) return;
        if (JSON.stringify(rotationActions.getCurrentRotationData()) !== fingerprint) {
            error =
                'The editor changed since this search started. Reopen the planner to use the new setup.';
            return;
        }
        const r = structuredClone(result.best.rotation);
        for (let t = displayEnd; t < request.end; t++) {
            r.abilityBar[t] = null;
            r.stalledAbilities[t] = null;
            if (r.releasedAbilities) r.releasedAbilities[t] = null;
        }
        const appliedSettings = JSON.parse(JSON.stringify(settings));
        if (request.zeroStartingResources) resetPreparationResources(appliedSettings);
        rotationActions.applyRotationData({
            ...original,
            a: r.abilityBar,
            e: r.extraActionBar,
            n: r.nulledTicks,
            t: r.stalledAbilities,
            r: r.releasedAbilities,
            c: r.targetCounts,
            v: r.tickEvents,
            s: appliedSettings
        });
        refreshUI();
        applied = true;
    }
    function undo() {
        if (!applied) return;
        rotationActions.applyRotationData(original);
        refreshUI();
        applied = false;
    }
    function close() {
        stop();
        dialog?.close();
        open = false;
    }
    function points(curve: number[]) {
        const max = Math.max(1, ...(result?.best?.curve ?? []), ...(result?.baseline?.curve ?? []));
        return curve
            .map((y, i) => `${(i / Math.max(1, curve.length - 1)) * 600},${150 - (y / max) * 140}`)
            .join(' ');
    }
    onDestroy(stop);
</script>

<button class="planner-launch" onclick={begin}>Build a rotation <span>Vorkath planner</span></button
>
{#if open}
    <dialog
        bind:this={dialog}
        class="planner"
        aria-label="Vorkath rotation planner"
        oncancel={close}
    >
        <header>
            <div>
                <h2>Build a rotation</h2>
                <p>Find a stronger sequence for your setup.</p>
            </div>
            <button onclick={close} aria-label="Close planner">Close</button>
        </header>
        <nav aria-label="Planner steps">
            {#each ['Fight & goal', 'Loadouts & stacks', 'Allowed actions', 'Search & compare'] as label, i}<button
                    disabled={running || (i === 3 && !result)}
                    class:active={step === i}
                    onclick={() => (step = i)}>{i + 1}. {label}</button
                >{/each}
        </nav>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if step === 0}
            <h3>What are you trying to achieve?</h3>
            <div class="fields">
                <label
                    >Goal<select bind:value={objective}
                        ><option value="time">Reach a damage target as quickly as possible</option
                        ><option value="damage">Most damage within a time limit</option></select
                    ></label
                >
                {#if objective === 'time'}<label
                        >{team
                            ? 'Team damage / remaining HP target'
                            : 'Your damage / remaining HP target'}<input
                            type="number"
                            min="1"
                            bind:value={goal}
                        /></label
                    >{/if}
                <label
                    >Count damage to<select bind:value={scope}
                        ><option value="all">All targets combined</option><option value="main"
                            >Main target only</option
                        ></select
                    ></label
                >
                <label
                    >Fighting<select bind:value={settings[SETTINGS.BOSS_PRESET]}
                        ><option value="none">Custom target</option
                        >{#each Object.keys(bossPresets).sort() as key}<option value={key}
                                >{bossPresets[key].name}</option
                            >{/each}</select
                    ></label
                >
                <label
                    >Targets in range<input
                        type="number"
                        min="1"
                        max="25"
                        step="1"
                        bind:value={targets}
                    /></label
                >
                <label
                    >Keep existing setup before tick<input
                        type="number"
                        min="0"
                        max={MAX_ROTATION_TICKS - 1}
                        step="1"
                        bind:value={start}
                        disabled={prep}
                    /><small
                        >0 rebuilds from the beginning. A later tick keeps everything before it.</small
                    ></label
                >
                {#if objective === 'damage'}<label
                        >Damage comparison duration (ticks)<input
                            type="number"
                            min="1"
                            max={MAX_ROTATION_TICKS - start - prepTicks}
                            step="1"
                            bind:value={ticks}
                        /><small
                            >{(ticks * 0.6).toFixed(1)} seconds of fighting; starts at tick {prep
                                ? prepTicks
                                : start}</small
                        ></label
                    >{/if}
            </div>
            {#if objective === 'time'}<p class="note">
                    The fight runs until your damage target and phase requirements are met. There is
                    no configured fight deadline. Only Wars and dummy preparation have length caps;
                    search time controls how long the computer explores alternatives.
                </p>{/if}
            <h3>Team and damage share</h3>
            <label class="check"
                ><input type="checkbox" bind:checked={team} /> Plan my share of a team fight</label
            >
            {#if team}<div class="fields">
                    <label
                        >Damage dealers (including you)<input
                            type="number"
                            min="1"
                            max="50"
                            step="1"
                            bind:value={dealers}
                        /></label
                    >
                    <label
                        >Additional players (+1, +2...)<input
                            type="number"
                            min="0"
                            max="50"
                            step="1"
                            bind:value={extras}
                        /></label
                    >
                    <label
                        >Each extra player's contribution (% of a dealer)<input
                            type="number"
                            min="0"
                            max="100"
                            bind:value={extraContribution}
                        /></label
                    >
                </div>
                <p class="note">
                    {dealers}+{extras}: your share is {(share * 100).toFixed(1)}% ({Math.round(
                        goal * share
                    ).toLocaleString()} damage). Active dealers share equally; 0% extras add no damage.
                    Enter the boss HP for your actual team size above; HP scaling is not guessed. Phase
                    requirements use this same share.
                </p>{/if}
            <h3>Before the fight</h3>
            {#if !prep}<button onclick={addWars}>Add Wars and travel</button>{:else}
                <div class="fields">
                    <label
                        >Wars prebuild cap (ticks)<input
                            type="number"
                            min="1"
                            max="200"
                            step="1"
                            bind:value={warsTicks}
                        /><small
                            >{(warsTicks * 0.6).toFixed(1)} seconds; unused time can be spent waiting.</small
                        ></label
                    >
                    <label
                        >Travel to the instance (seconds)<input
                            type="number"
                            min="0"
                            max="120"
                            step="0.6"
                            bind:value={travelSeconds}
                        /></label
                    >
                </div>
                <label class="check"
                    ><input type="checkbox" bind:checked={dummyAvailable} /> I can place a dummy before
                    starting this fight</label
                >
                {#if dummyAvailable}<label
                        >In-instance dummy prebuild cap (ticks)<input
                            type="number"
                            min="0"
                            max="200"
                            step="1"
                            bind:value={dummyTicks}
                        /></label
                    >{/if}
                <p class="note">
                    Wars → Travel{dummyAvailable && dummyTicks > 0 ? ' → Prebuild' : ''} → Fight at tick
                    {prepTicks}. Setup is rebuilt using allowed abilities. Travel has no attacks;
                    buffs and cooldowns keep ticking. Dummy damage does not count toward boss
                    damage. Existing actions inside the new setup section are replaced.
                </p>
                <button onclick={() => (prep = false)}>Remove preparation sections</button>
            {/if}
            <p class="note">
                PvME examples: <a
                    href="https://pvme.io/pvme-guides/rs3-full-boss-guides/angel-of-death-small-teams/magic-melee-hybrid-base/"
                    target="_blank"
                    rel="noreferrer">AoD hybrid prebuild</a
                >
                ·
                <a
                    href="https://pvme.io/pvme-guides/one-tick-guides/basic-one-ticks/"
                    target="_blank"
                    rel="noreferrer">Wars and instance prebuilds</a
                >. Dummy availability and travel time depend on the encounter.
            </p>
            <label class="check"
                ><input type="checkbox" bind:checked={settings[SETTINGS.AUTO_ACCURACY]} /> Calculate
                accuracy from target and gear</label
            >
            {#if !settings[SETTINGS.AUTO_ACCURACY]}<label
                    >Damage potential (%)<input
                        type="number"
                        min="0"
                        max="100"
                        bind:value={settings[SETTINGS.HIT_CHANCE]}
                    /></label
                >{/if}
            {#if /ghrazi/i.test(settings[SETTINGS.BOSS_PRESET] ?? '')}
                <label class="check"
                    ><input type="checkbox" bind:checked={autoDistance} /> Let the planner choose knight
                    distance during the fight</label
                >
                {#if autoDistance}
                    <div class="fields">
                        <label
                            >Separated-knights melee AoE position<select bind:value={meleeOwner}
                                ><option value={true}>Mine (one player only)</option><option
                                    value={false}>Another player's</option
                                ></select
                            ></label
                        >
                        <label
                            >Ticks spent repositioning<input
                                type="number"
                                min="1"
                                max="20"
                                step="1"
                                bind:value={moveTicks}
                            /></label
                        >
                    </div>
                    {#each [3, 2, 1, 0] as distance}<label class="check"
                            ><input
                                type="checkbox"
                                checked={distances.includes(distance)}
                                onchange={(e) =>
                                    (distances = e.currentTarget.checked
                                        ? [...distances, distance]
                                        : distances.filter((d) => d !== distance))}
                            />{distance === 0 ? 'Overlapping' : `${distance} clear tiles`}</label
                        >{/each}
                    <p class="note">
                        Repositioning costs attack time. At 3+ clear tiles, only the assigned player
                        with an equipped halberd-range melee loadout gets both targets; other
                        attacks count one. Proximity accuracy is approximate. Your teammate must
                        coordinate these movements.
                    </p>
                {/if}<label
                    >Initial distance between knights<select
                        bind:value={settings[SETTINGS.GHRAZI_DISTANCE]}
                        ><option value={3}>3+ clear tiles</option><option value={2}
                            >2 clear tiles</option
                        ><option value={1}>1 clear tile</option><option value={0}
                            >Overlapping</option
                        ></select
                    ></label
                >{/if}
            <p class="note">
                Actions before the replacement tick are kept as setup. Outside rebuilt preparation,
                scripted utilities and gear swaps stay fixed. Automatic positioning may replace
                distance changes. Casts inside the search window are replaced only when you apply a
                result.
            </p>
            <details class="phases">
                <summary>Fight phases ({phases.length})</summary>
                <p class="note">
                    Set scheduled phase starts and invulnerable ticks. With preparation enabled,
                    fight sections shift together to follow preparation. Cooldowns and resources
                    carry between phases unless you select a reset. Optional damage requirements
                    must be met before the next phase; the search prioritises meeting all of them.
                    Known boss HP-triggered transitions are also simulated from the selected boss
                    preset.
                </p>
                {#each phases as phase, i}<div class="phase-row">
                        <label>Phase name<input bind:value={phase.name} /></label><label
                            >Start tick<input
                                type="number"
                                min="0"
                                max={MAX_ROTATION_TICKS - 1}
                                step="1"
                                bind:value={phase.tick}
                            /></label
                        ><label
                            >Invulnerable ticks<input
                                type="number"
                                min="0"
                                max="300"
                                step="1"
                                bind:value={phase.downtime}
                            /></label
                        ><label
                            >Damage required in phase (0 = none)<input
                                type="number"
                                min="0"
                                bind:value={phase.damage}
                            /></label
                        ><label class="check"
                            ><input
                                type="checkbox"
                                checked={!!phase.clearStacks.length}
                                onchange={(e) =>
                                    (phase.clearStacks = e.currentTarget.checked
                                        ? phaseStackOptions.map(([key]) => key)
                                        : [])}
                            />Clear stacks at start</label
                        ><button onclick={() => (phases = phases.filter((_, j) => i !== j))}
                            >Remove phase</button
                        >
                    </div>{/each}
                <button onclick={addPhase}>Add phase</button>
            </details>
            <button class="primary" onclick={() => (step = 1)}>Next: loadouts & stacks</button>
        {:else if step === 1}
            <h3>Which configured loadouts may it use?</h3>
            <p class="note">
                Uses your current editor gear, perks, relics, familiar and buffs. Check only
                loadouts you can use. With multiple styles selected, it searches style switches
                using those loadouts. Change equipment in the editor before opening the planner.
            </p>
            <label
                >Combat mode<select
                    value={mode}
                    onchange={(e) => setMode(Number(e.currentTarget.value))}
                    ><option value={1}>Single style</option><option value={2}
                        >Brid - two styles</option
                    ><option value={3}>Tribrid - three styles</option><option value={4}
                        >All four styles</option
                    ></select
                ></label
            >
            <label class="check"
                ><input type="checkbox" bind:checked={stayInBurst} /> Stay in the burst style during
                Berserk, Death's Swiftness, Sunshine or Living Death</label
            >
            {#if stayInBurst}<label class="check"
                    ><input type="checkbox" bind:checked={stackDetours} /> Allow one stack-building basic
                    in another style, then return</label
                >{/if}
            <p class="note">
                Stack detours are candidates, not mandatory switches. They only replace a full burst
                sequence if the complete result is better. Untick the burst restriction to let the
                search try unrestricted switches.
            </p>
            <div class="loadouts">
                {#each styleLabels as [style, label]}<label class="check"
                        ><input
                            type="checkbox"
                            checked={styles.includes(style)}
                            disabled={!styles.includes(style) && styles.length >= mode}
                            onchange={(e) => selectStyle(style, e.currentTarget.checked)}
                        />{label}</label
                    >{/each}
            </div>
            {#each styles as style}{@const prefix =
                    style === 'necromancy' ? 'necro' : style}{@const type =
                    settings['weapon type ' + (style === 'magic' ? 'mage' : prefix)]}
                <p>
                    {styleLabels.find(([key]) => key === style)?.[1]}:
                    <strong
                        >{getEquipment(
                            settings[
                                `${prefix} ${type === 'two-hand' ? 'two-hand' : 'main-hand'} weapon`
                            ]
                        )?.title ?? 'Custom weapon'}</strong
                    >
                </p>{/each}
            {#if prep}
                <h3>Resources are built during preparation</h3>
                <p class="note">
                    Wars starts with zero adrenaline and zero stacks. The planner earns adrenaline
                    through abilities and the crystal, and builds Bloodlust, arrow stacks and other
                    resources through their actual casts and hits. They carry into the fight only if
                    they survive travel and the encounter's reset rules. No starting stacks are
                    granted.
                </p>
            {:else}
                <h3>Resources come from your actions</h3>
                <p class="note">
                    A rebuild from tick 0 starts with zero adrenaline and stacks. Add Wars in Fight
                    &amp; goal to build them before the fight. If you keep an existing prefix, its
                    simulated state carries into the new rotation.
                </p>
            {/if}
            <button class="primary" onclick={() => (step = 2)}>Next: allowed actions</button>
        {:else if step === 2}
            <h3>Which abilities and specials can you use?</h3>
            <p class="note">
                Untick locked abilities or actions you cannot perform. Weapon-compatible specials
                are selected by default. Other listed specials require the selected weapon inside
                your equipped Essence of Finality; tick only those you actually have. Buff abilities
                are included so the search can trade early damage for a stronger finish.
            </p>
            <input
                aria-label="Find an ability"
                placeholder="Find an ability..."
                bind:value={search}
            />
            <div class="ability-list">
                {#each shown as key}<label class="check"
                        ><input
                            type="checkbox"
                            checked={allowed.includes(key)}
                            onchange={(e) =>
                                (allowed = e.currentTarget.checked
                                    ? [...allowed, key]
                                    : allowed.filter((k) => k !== key))}
                        />{abils[key].title}{#if abils[key].abilityType === 'special attack'}<small
                                >Special</small
                            >{/if}</label
                    >{/each}
            </div>
            {#if styles.includes('ranged')}<h3>Which ammunition may it switch between?</h3>
                <p class="note">
                    Select ammunition you have. With no selections it keeps the equipped ammunition
                    and existing swaps. Selected ammo switches occur before casts; the simulator
                    still resolves hit-time effects separately.
                </p>
                <div class="ability-list ammo">
                    {#each ammunition as item}<label class="check"
                            ><input
                                type="checkbox"
                                checked={ammo.includes(item.id)}
                                onchange={(e) =>
                                    (ammo = e.currentTarget.checked
                                        ? [...ammo, item.id]
                                        : ammo.filter((id) => id !== item.id))}
                            />{item.title}</label
                        >{/each}
                </div>{/if}
            <label
                >Computer search time<select bind:value={seconds}
                    ><option value={15}>Quick - 15 seconds</option><option value={30}
                        >Standard - 30 seconds</option
                    ><option value={120}>Thorough - 2 minutes</option><option value={300}
                        >Deep - 5 minutes</option
                    ></select
                ></label
            >
            <p class="note">
                Searches complete sequences, including waits, using expected damage and adrenaline.
                It preserves your scripted utilities, conjures, stalls and releases outside the
                search window; Wars can use the adrenaline crystal alongside self-buffs or waits. It
                does not invent stalls/releases or unconfigured equipment swaps. Results depend on
                the simulator's accuracy and are the best found, not a proof of the global optimum.
            </p>
            <button class="primary" onclick={run}>Search rotations</button>
        {:else}
            <h3>{running ? 'Searching full rotations...' : 'Best rotation found'}</h3>
            {#if result}<p role="status">
                    {result.trials} rotations checked in {result.elapsed.toFixed(1)} seconds
                </p>{/if}
            {#if running}<p>
                    The editor remains responsive. You can stop and keep the best result found so
                    far.
                </p>
                <button onclick={stop}>Stop search</button>{/if}
            {#if result?.limitation}<p class="note">{result.limitation}</p>{/if}
            {#if result?.best}
                <div class="results">
                    <div>
                        <span>Expected damage by finish</span><strong
                            >{Math.round(
                                result.best.curve[displayEnd - request.start - 1] ?? 0
                            ).toLocaleString()}</strong
                        >
                    </div>
                    <div>
                        <span>Current rotation at the same time</span><strong
                            >{Math.round(
                                result.baseline.curve[displayEnd - request.start - 1] ?? 0
                            ).toLocaleString()}</strong
                        >
                    </div>
                    {#if request.objective === 'time'}<div>
                            <span>Time to damage target</span><strong
                                >{result.best.reached === null
                                    ? 'No complete rotation found yet'
                                    : (
                                          (result.best.reached -
                                              ((request.fightStart ?? request.start) -
                                                  request.start)) *
                                          0.6
                                      ).toFixed(1) + ' seconds'}</strong
                            >
                        </div>{/if}
                </div>
                {#if !result.baseline.valid}<p class="note">
                        The current rotation contains an unavailable cast under these choices, so
                        its damage is shown for reference only.
                    </p>{/if}
                <svg
                    viewBox="0 0 600 160"
                    role="img"
                    aria-label="Cumulative damage over the search window: gold is the best found rotation; grey is the current rotation"
                    ><polyline
                        points={points(result.baseline.curve)}
                        fill="none"
                        stroke="#798a94"
                        stroke-width="2"
                    /><polyline
                        points={points(result.best.curve)}
                        fill="none"
                        stroke="#e4c377"
                        stroke-width="3"
                    /></svg
                >
                <p class="note">
                    Cumulative damage: gold = best found; grey = current rotation. Only hits landing
                    inside the window count.
                </p>
                {#if result.best.phaseOutcomes?.length}<h3>Phase requirements</h3>
                    <ul>
                        {#each result.best.phaseOutcomes as phase}<li>
                                {phase.name}: {Math.round(phase.damage).toLocaleString()} / {Math.round(
                                    phase.goal
                                ).toLocaleString()} damage {phase.reached === null
                                    ? '(not reached)'
                                    : '(met)'}
                            </li>{/each}
                    </ul>{/if}
                {#if request.objective === 'time' && result.best.reached !== null}<p class="note">
                        The proposed casts finish once the damage target and all phase requirements
                        are met.
                    </p>{/if}
                <details>
                    <summary>Review the proposed casts and positioning</summary>
                    {#each result.best.rotation.tickEvents as event, tick}
                        {#if tick >= request.start && tick < displayEnd && (event?.phase || event?.ghraziDistance != null)}
                            <p>
                                Tick {tick}: {event.phase ?? ''}
                                {event.ghraziDistance != null
                                    ? `Knights: ${event.ghraziDistance} clear tiles`
                                    : ''}
                            </p>
                        {/if}
                    {/each}
                    <ol>
                        {#each result.best.rotation.abilityBar.slice(request.start, displayEnd) as ability, i}{#if ability}<li
                                >
                                    Tick {request.start + i}: {abils[ability]?.title ??
                                        ability}{#if result.best.rotation.tickEvents?.[request.start + i]?.castAmmo}
                                        / {getEquipment(
                                            result.best.rotation.tickEvents[request.start + i]
                                                .castAmmo
                                        )?.title}{/if}
                                </li>{/if}{/each}
                    </ol>
                </details>
                <button
                    class="primary"
                    disabled={running ||
                        applied ||
                        (request.objective === 'time' && result.best.reached === null)}
                    onclick={apply}
                    >{applied ? 'Applied to timeline' : 'Apply to searched ticks'}</button
                >
                {#if applied}<button onclick={undo}>Undo planner changes</button>{/if}
            {:else if !running}<p>
                    No valid result was found. Check your allowed abilities, gear and starting
                    resources.
                </p>{/if}
            {#if !running}<button onclick={() => (step = 2)}>Change choices / search again</button
                >{/if}
        {/if}
    </dialog>
{/if}

<style>
    .planner-launch {
        padding: 10px 16px;
        background: #253a40;
        border: 1px solid #bda56b;
        color: #e4c377;
        border-radius: 5px;
        margin: 8px 0;
    }
    .planner-launch span {
        font-size: 11px;
        color: #a6c6d5;
        margin-left: 12px;
    }
    .planner::backdrop {
        background: #000b;
    }
    .planner {
        margin: auto;
        width: min(900px, calc(100% - 32px));
        max-height: 90vh;
        overflow: auto;
        background: #161e22;
        color: #c4deed;
        border: 1px solid #4d6672;
        border-radius: 10px;
        padding: 24px;
        box-shadow: 0 20px 70px #0008;
    }
    .planner header {
        display: flex;
        justify-content: space-between;
        align-items: start;
        gap: 20px;
    }
    .planner h2 {
        font-size: 24px;
        color: #e4c377;
        margin: 0;
    }
    .planner h3 {
        font-size: 18px;
        margin: 20px 0 12px;
    }
    .planner nav {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        margin: 18px 0;
    }
    .planner button {
        padding: 8px 12px;
        border: 1px solid #536975;
        border-radius: 4px;
        background: #24323a;
        color: #c4deed;
        cursor: pointer;
    }
    .planner button.active,
    .planner button.primary {
        background: #bda56b;
        color: #10191e;
    }
    .planner button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .planner button.primary {
        margin: 18px 8px 0 0;
    }
    .fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
    }
    .planner label {
        display: flex;
        flex-direction: column;
        gap: 7px;
        font-size: 13px;
    }
    .planner input:not([type='checkbox']),
    .planner select {
        width: 100%;
        padding: 8px;
        background: #101c23;
        color: #c4deed;
        border: 1px solid #506775;
        border-radius: 4px;
        color-scheme: dark;
    }
    .planner label.check {
        flex-direction: row;
        align-items: center;
        gap: 8px;
        padding: 5px 0;
    }
    .planner input[type='checkbox'] {
        accent-color: #cbb072;
    }
    .note,
    .planner small {
        font-size: 12px;
        line-height: 1.6;
        color: #96b8c9;
    }
    .loadouts {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
    }
    .ability-list {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 2px 15px;
        max-height: 280px;
        overflow: auto;
        border: 1px solid #344c58;
        padding: 10px;
        margin: 12px 0;
    }
    .ability-list.ammo {
        max-height: 170px;
    }
    .phase-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        border: 1px solid #344c58;
        border-radius: 4px;
        padding: 12px;
        margin: 12px 0;
    }
    .results {
        display: flex;
        gap: 30px;
        flex-wrap: wrap;
        margin: 16px 0;
    }
    .results span {
        display: block;
        font-size: 12px;
    }
    .results strong {
        font-size: 21px;
        color: #e4c377;
    }
    .error {
        color: #ffada4;
    }
    .planner svg {
        width: 100%;
        background: #10191e;
        border: 1px solid #344c58;
        border-radius: 4px;
        margin-top: 12px;
    }
    .planner li {
        font-size: 12px;
        margin: 5px 0;
    }
    .planner details {
        margin: 12px 0;
    }
    @media (max-width: 600px) {
        .fields,
        .ability-list {
            grid-template-columns: 1fr;
        }
        .planner {
            padding: 15px;
        }
    }
</style>
