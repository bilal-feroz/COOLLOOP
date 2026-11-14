"""Reference facility and operating configuration.

The facility is a *synthetic reference design*, not a real site. Every number
here is a documented design assumption, and anything derived from it is a
simulated value, never a measurement.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Location(BaseModel):
    name: str = "Abu Dhabi, UAE"
    lat: float = Field(24.4539, ge=-90, le=90)
    lon: float = Field(54.3773, ge=-180, le=180)
    utc_offset_hours: float = Field(4.0, ge=-12, le=14)
    elevation_m: float = 5.0


class Facility(BaseModel):
    """Design data of the hybrid-cooled reference data centre."""

    id: str = "CL-AUH-01"
    name: str = "Reference hybrid-cooled data centre"
    synthetic: bool = True

    # --- IT and white space -------------------------------------------------
    it_design_kw: float = 12_000.0
    it_min_kw: float = 2_400.0
    rack_count: int = 400
    electrical_loss_fraction: float = 0.03  # UPS / PDU losses released in the hall
    crah_fan_design_kw: float = 380.0
    crah_min_speed: float = 0.5
    crah_approach_design_k: float = 6.0  # server inlet minus CHW supply at design load
    server_inlet_limit_c: float = 27.0  # ASHRAE TC 9.9 recommended upper limit (class A1)
    room_setpoint_c: float = 24.0
    room_rh: float = 0.45

    # --- Building envelope --------------------------------------------------
    roof_area_m2: float = 2_560.0
    roof_u_w_m2k: float = 0.30
    roof_absorptance: float = 0.35
    wall_area_m2: float = 2_290.0
    wall_u_w_m2k: float = 0.35
    ventilation_kg_s: float = 4.0

    # --- Chilled water ------------------------------------------------------
    chw_delta_t_k: float = 8.0
    chw_supply_min_c: float = 10.0
    chw_supply_max_c: float = 22.0
    chw_pump_design_kw: float = 165.0

    # --- Water-cooled chillers (wet plant) ----------------------------------
    wc_chiller_count: int = 5  # N+1
    wc_chiller_capacity_kw: float = 3_200.0
    wc_carnot_efficiency: float = 0.68
    evaporator_approach_k: float = 2.5
    condenser_approach_k: float = 2.5
    chiller_min_lift_k: float = 12.0  # head-pressure control keeps at least this lift

    # --- Condenser water loop -----------------------------------------------
    cw_pump_count: int = 5  # N+1
    cw_pump_design_kw: float = 200.0  # all duty pumps at design flow
    cw_static_head_fraction: float = 0.30
    cw_pump_speed_min: float = 0.45
    cws_max_c: float = 36.0  # chiller condenser entering-water limit
    cws_min_c: float = 17.0  # minimum for stable chiller head pressure
    cw_range_max_k: float = 9.0

    # --- Cooling towers (induced-draft counterflow cells) --------------------
    tower_cell_count: int = 5  # N+1
    tower_cells_duty: int = 4
    tower_design_rejection_kw: float = 3_700.0  # per cell
    tower_design_wet_bulb_c: float = 30.0
    tower_design_dry_bulb_c: float = 36.0
    tower_design_approach_k: float = 4.0
    tower_design_range_k: float = 5.5
    tower_design_lg: float = 1.3  # water-to-air mass flow ratio at design
    tower_ntu_exponent: float = -0.6
    tower_fan_design_kw: float = 45.0  # per cell
    tower_fan_speed_min: float = 0.25
    tower_cell_flow_min: float = 0.50  # fraction of design flow that keeps the fill wetted
    tower_cell_flow_max: float = 1.25  # hydraulic limit of the distribution system
    drift_fraction: float = 2.0e-5  # 0.002 % of circulating flow, modern eliminators
    coc_min: float = 2.0
    coc_max: float = 7.0  # assumed scaling limit for the makeup-water chemistry

    # --- Air-cooled chillers (dry plant) ------------------------------------
    ac_chiller_count: int = 4
    ac_chiller_capacity_kw: float = 1_600.0  # rated at 35 degC ambient
    ac_rating_ambient_c: float = 35.0
    ac_derate_per_k: float = 0.012
    ac_carnot_efficiency: float = 0.50
    ac_condenser_approach_design_k: float = 16.0
    ac_condensing_limit_c: float = 68.0
    ac_fan_design_kw: float = 36.0  # per unit

    # --- Water storage ------------------------------------------------------
    tank_capacity_m3: float = 1_500.0
    tank_reserve_fraction: float = 0.25
    tank_initial_fraction: float = 0.78  # synthetic baseline telemetry

    @property
    def cw_flow_design_kg_s(self) -> float:
        """Total condenser-water flow with all duty cells at design range."""
        return self.tower_cells_duty * self.tower_design_cell_water_kg_s

    @property
    def tower_design_cell_water_kg_s(self) -> float:
        return self.tower_design_rejection_kw / (4.186 * self.tower_design_range_k)

    @property
    def tower_design_cell_air_kg_s(self) -> float:
        return self.tower_design_cell_water_kg_s / self.tower_design_lg

    @property
    def cooling_load_design_kw(self) -> float:
        return self.it_design_kw * (1.0 + self.electrical_loss_fraction) + self.crah_fan_design_kw

    @property
    def dry_capacity_rated_kw(self) -> float:
        return self.ac_chiller_count * self.ac_chiller_capacity_kw


class OperatingConfig(BaseModel):
    """Operator-adjustable set points. This is what a scenario changes."""

    it_load_kw: float = Field(9_000.0, ge=2_400.0, le=12_000.0)
    chw_supply_c: float = Field(16.0, ge=10.0, le=22.0)
    tower_fan_speed: float = Field(1.0, ge=0.25, le=1.0)
    cw_pump_speed: float = Field(1.0, ge=0.45, le=1.0)
    # gt=1 keeps the blowdown denominator (COC - 1) strictly positive.
    cycles_of_concentration: float = Field(3.5, gt=1.0, ge=2.0, le=10.0)
    wet_fraction: float = Field(1.0, ge=0.0, le=1.0)
    tower_cells_online: int = Field(4, ge=1, le=5)
    water_allocation_m3_day: float = Field(850.0, ge=0.0, le=3_000.0)


class AmbientOverride(BaseModel):
    """Manual ambient conditions for what-if runs (replaces the forecast)."""

    t_db_c: float = Field(..., ge=-5.0, le=55.0)
    rh_pct: float = Field(..., ge=3.0, le=100.0)


FACILITY = Facility()
BASELINE_CONFIG = OperatingConfig()
