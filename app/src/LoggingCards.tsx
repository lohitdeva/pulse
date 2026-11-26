import {
  BOTTLE_ML,
  MEALS,
  type MealName,
  type MealPlace,
  type mealsSummary,
  type waterTotals,
} from "@pulse/shared";
import { Card } from "./ui";

const MEAL_LABELS: Record<MealName, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  snacks: "Snacks",
  dinner: "Dinner",
};

const PLACES: ReadonlyArray<{ place: MealPlace; label: string }> = [
  { place: "mess", label: "Mess" },
  { place: "outside", label: "Outside" },
  { place: "ordered_in", label: "Ordered in" },
];

function litres(ml: number): string {
  return `${(ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 1)} L`;
}

export function WaterCard({
  totals,
  onAdd,
}: {
  totals: ReturnType<typeof waterTotals>;
  onAdd: (amountMl: number, isGym: boolean) => void;
}) {
  const bottles = Math.round(totals.bottles * 10) / 10;
  return (
    <Card className="log-card water-card" role="group" aria-label="Water">
      <div className="log-head">
        <h2 className="log-title">Water</h2>
        <span className="log-count">
          {litres(totals.drankMl)} / {litres(totals.targetMl)}
        </span>
      </div>
      <div
        className="now-bar"
        role="progressbar"
        aria-label="Water toward 2 litre target"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(totals.fraction * 100)}
      >
        <span className="now-bar-fill" style={{ width: `${totals.fraction * 100}%` }} />
      </div>
      <p className="log-note">
        {bottles} of {totals.targetMl / BOTTLE_ML} bottles
      </p>
      <div className="log-actions">
        <button className="button button-secondary" type="button" onClick={() => onAdd(BOTTLE_ML / 2, false)}>
          +½ bottle
        </button>
        <button className="button button-primary" type="button" onClick={() => onAdd(BOTTLE_ML, false)}>
          +1 bottle
        </button>
      </div>
      <div className="log-gym">
        <div className="log-gym-copy">
          <span className="log-gym-title">Gym water</span>
          <span className="log-note">{litres(totals.gymMl)} · not counted toward the 2 L</span>
        </div>
        <div className="log-actions">
          <button
            className="button button-secondary"
            type="button"
            aria-label="Add half a bottle of gym water"
            onClick={() => onAdd(BOTTLE_ML / 2, true)}
          >
            +½
          </button>
          <button
            className="button button-secondary"
            type="button"
            aria-label="Add one bottle of gym water"
            onClick={() => onAdd(BOTTLE_ML, true)}
          >
            +1
          </button>
        </div>
      </div>
    </Card>
  );
}

export function MealsCard({
  summary,
  onSet,
}: {
  summary: ReturnType<typeof mealsSummary>;
  onSet: (meal: MealName, place: MealPlace) => void;
}) {
  return (
    <Card className="log-card meals-card" role="group" aria-label="Meals">
      <div className="log-head">
        <h2 className="log-title">
          Meals {summary.logged}/{summary.total}
        </h2>
        {summary.eatingOut > 0 ? <span className="log-count">{summary.eatingOut} eating out</span> : null}
      </div>
      <ul className="meal-list">
        {MEALS.map((meal) => (
          <li key={meal} className="meal-row">
            <span className="meal-name">{MEAL_LABELS[meal]}</span>
            <div className="meal-places" role="group" aria-label={`${MEAL_LABELS[meal]} location`}>
              {PLACES.map(({ place, label }) => {
                const selected = summary.byMeal[meal] === place;
                return (
                  <button
                    key={place}
                    type="button"
                    className={`place-btn${selected ? " place-btn-active" : ""}`}
                    aria-pressed={selected}
                    onClick={() => onSet(meal, place)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
