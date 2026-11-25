import { FilteredListHeader } from "../components/FilteredListHeader";
import { Icon } from "../components/Icon";
import { InsightStrip } from "../components/InsightStrip";
import { useState } from "react";
import { ProjectListRow } from "../components/ProjectListRow";

import { TASKS, TASK_LANES, type TaskLane, type TaskCardData } from "../data/fixtures";

import type { InsightVariant } from "../urlState";
import "./TasksScreen.css";

function TaskCard(props: { task: TaskCardData; light: boolean; onOpen: () => void }) {
  const { task } = props;
  return (
    <ProjectListRow
      project={task.project}
      light={props.light}
      status={task.dot}
      title={task.title}
      onOpen={props.onOpen}
    >
      {task.project.toLowerCase()} · <span className="m-tnum">#{task.id}</span> ·{" "}
      {task.subtasks && task.subtasks + " ·"} <span className="m-tnum">{task.time}</span> ·{" "}
      {task.node}
      {task.pr ? (
        <>
          {" · "}
          <span className="m-task-pr m-tnum" data-state={task.pr.state}>
            <Icon name={task.pr.state === "merged" ? "merge" : "pull-request"} size={12} />#
            {task.pr.number}
          </span>
        </>
      ) : null}
    </ProjectListRow>
  );
}

export function TasksScreen(props: {
  loaded: boolean;
  insights?: InsightVariant | undefined;
  chart: boolean;
  light: boolean;
  query: string;
  onOpen: (id: number) => void;
}) {
  const [lane, setLane] = useState<TaskLane>("In progress");
  const tasks = TASKS.filter(
    (t) =>
      t.lane === lane &&
      [t.title, t.project, t.node, "#" + t.id]
        .join(" ")
        .toLowerCase()
        .includes(props.query.trim().toLowerCase()),
  );
  return (
    <div className="m-list m-tasks">
      <div className="m-tasks-scroll m-scroll">
        <FilteredListHeader
          title="Tasks"
          subtitle={props.loaded ? `${lane} · ${tasks.length}` : undefined}
          filterLabel="Filter tasks"
          options={TASK_LANES.map((label) => ({
            label,
            count: TASKS.filter((task) => task.lane === label).length,
          }))}
          selected={lane}
          onSelect={setLane}
        />
        {props.loaded && props.insights && (
          <InsightStrip
            key={`${props.insights}-${props.chart}`}
            variant={props.insights}
            initiallyOpen={props.chart}
          />
        )}
        {!props.loaded && (
          <div className="ios-empty">
            <strong>Tasks are unavailable</strong>
            <p>The Orbit Gateway did not answer. Pull to try again.</p>
          </div>
        )}
        {props.loaded && !tasks.length && <div className="ios-empty">No matching tasks</div>}
        {props.loaded &&
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              light={props.light}
              onOpen={() => props.onOpen(task.id)}
            />
          ))}
      </div>
    </div>
  );
}
