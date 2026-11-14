"use client";

import { Grid } from "@react-three/drei";
import { useMemo } from "react";
import { useApp, useTwinPoint } from "@/lib/store";
import type { EquipmentState, PointResult } from "@/lib/types";
import { AccFans, AirFlow, Beacons, type Drivers, Plumes, Tank, TowerFans, useLoadGlow } from "./Dynamics";
import { accParts, chillerParts, pumpParts, towerParts, towerRowParts } from "./equipment";
import { Interaction } from "./Interaction";
import { Kit, place } from "./kit";
import { ACC_POS, CHILLER_X, CHILLER_Z, CHW_PUMP_Z, CW_PUMP_Z, ROOF_DECK_Y, TOWER_X, TOWER_Z } from "./layout";
import { materials } from "./materials";
import { type FlowRates, Pipes } from "./Pipes";
import { hallParts, plantParts, siteParts, tankParts, whiteSpaceParts } from "./site";

const metric = (item: EquipmentState | undefined, label: string): number =>
  item?.metrics.find((m) => m.label === label)?.value ?? 0;

/** Plain numbers the moving parts need, taken from the simulated point. */
function derive(point: PointResult | null): { drivers: Drivers; flows: FlowRates; equipment: Record<string, EquipmentState> } {
  const equipment: Record<string, EquipmentState> = Object.fromEntries((point?.equipment ?? []).map((e) => [e.id, e]));
  const t = point?.thermal;
  const w = point?.water;
  const speed = (ratio: number, base: number, gain: number) => (ratio > 0.0005 ? base + gain * Math.min(ratio, 1.3) : 0);
  const cw = speed((t?.cw_flow_m3_h ?? 0) / 2320, 0.8, 2.2);
  const chw = speed((t?.chw_flow_m3_h ?? 0) / 1370, 0.8, 2.0);
  const roof = speed((t?.dry_load_kw ?? 0) / 6400, 0.7, 2.0);
  return {
    equipment,
    drivers: {
      towerFan: TOWER_X.map((_, i) => metric(equipment[`CT-0${i + 1}`], "Fan speed") / 100),
      towerHeat: TOWER_X.map((_, i) => metric(equipment[`CT-0${i + 1}`], "Heat rejection") / 3700),
      accLoad: ACC_POS.map((_, i) => {
        const item = equipment[`ACC-0${i + 1}`];
        const cap = metric(item, "Derated capacity");
        return cap > 0 ? metric(item, "Cooling load") / cap : 0;
      }),
      tankLevel: (w?.tank_level_pct ?? 78) / 100,
      itLoad: (t?.it_load_kw ?? 9000) / 12000,
      states: Object.fromEntries(Object.values(equipment).map((e) => [e.id, e.state])),
    },
    flows: {
      CWS: cw,
      CWR: cw,
      CHWS: chw,
      CHWR: chw,
      CHWS_ROOF: roof,
      CHWR_ROOF: roof,
      MU: speed((w?.makeup_m3_h ?? 0) / 30, 0.6, 1.8),
      BD: speed((w?.blowdown_m3_h ?? 0) / 10, 0.5, 1.5),
    },
  };
}

export function Scene() {
  const { point } = useTwinPoint();
  const cutaway = useApp((s) => s.layers.cutaway);
  const heat = useApp((s) => s.layers.heat);
  const air = useApp((s) => s.layers.air);
  const { drivers, flows, equipment } = useMemo(() => derive(point), [point]);
  useLoadGlow(drivers.itLoad, heat);
  const m = materials();

  // Static geometry: built once, drawn as a few instanced batches.
  const built = useMemo(() => {
    const hall = hallParts();
    const plant = plantParts();
    const [west, east] = [TOWER_X[0], TOWER_X[TOWER_X.length - 1]];
    return {
      always: [...siteParts(), ...tankParts(), ...whiteSpaceParts(), ...hall.always, ...plant.always, ...towerRowParts(west, east, TOWER_Z)],
      exterior: [...hall.exterior, ...plant.exterior],
      cutaway: [...hall.cutaway, ...plant.cutaway],
      tower: towerParts(),
      chiller: chillerParts(),
      acc: accParts(),
      pump: pumpParts(),
      towers: TOWER_X.map((x) => place([x, 0.06, TOWER_Z])),
      chillers: CHILLER_X.map((x) => place([x, 0.14, CHILLER_Z])),
      accs: ACC_POS.map(([x, z]) => place([x, ROOF_DECK_Y, z])),
      pumps: [
        ...CHILLER_X.map((x) => place([x, 0.14, CW_PUMP_Z])),
        ...CHILLER_X.map((x) => place([x, 0.14, CHW_PUMP_Z], Math.PI)),
      ],
    };
  }, []);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow material={m.ground} raycast={() => null}>
        <planeGeometry args={[1600, 1600]} />
      </mesh>
      <Grid
        position={[0, 0.005, 0]}
        infiniteGrid
        cellSize={5}
        sectionSize={25}
        cellThickness={0.6}
        sectionThickness={1}
        cellColor="#141a1f"
        sectionColor="#1f2930"
        fadeDistance={520}
        fadeStrength={1.4}
        followCamera={false}
      />

      <Kit parts={built.always} />
      <Kit parts={cutaway ? built.cutaway : built.exterior} />
      <Kit parts={built.tower} placements={built.towers} />
      <Kit parts={built.chiller} placements={built.chillers} />
      <Kit parts={built.acc} placements={built.accs} />
      <Kit parts={built.pump} placements={built.pumps} />

      <Pipes flows={flows} />
      <TowerFans drivers={drivers} />
      <AccFans drivers={drivers} />
      <Tank level={drivers.tankLevel} cutaway={cutaway} />
      <Beacons states={drivers.states} />
      <Plumes drivers={drivers} visible={heat} />
      <AirFlow drivers={drivers} visible={air} />
      <Interaction equipment={equipment} />
    </group>
  );
}
