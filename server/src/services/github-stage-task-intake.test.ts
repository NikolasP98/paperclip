import { describe, expect, it } from "vitest";
import { parseGithubStageTaskIntakeEnv } from "./github-stage-task-intake.js";

const pipelineId = "11111111-1111-4111-8111-111111111111";
const intakeProjectId = "22222222-2222-4222-8222-222222222222";
const classifierAgentId = "33333333-3333-4333-8333-333333333333";

describe("GitHub stage-task intake config", () => {
  it("is disabled unless an explicit stage-task pipeline is configured", () => {
    expect(parseGithubStageTaskIntakeEnv({})).toBeNull();
  });

  it("requires an attributed classifier agent and an operator-owned intake route when enabled", () => {
    expect(() =>
      parseGithubStageTaskIntakeEnv({ GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID: pipelineId }),
    ).toThrow("requires GITHUB_BUGS_INTAKE_PROJECT_ID");

    expect(() =>
      parseGithubStageTaskIntakeEnv({
        GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID: pipelineId,
        GITHUB_BUGS_INTAKE_PROJECT_ID: intakeProjectId,
        GITHUB_BUGS_CLASSIFIER_AGENT_ID: classifierAgentId,
        GITHUB_BUGS_STAGE_TASK_ROUTES_JSON: JSON.stringify([
          {
            key: "hub-workforce",
            name: "Workforce",
            projectId: "33333333-3333-4333-8333-333333333333",
            repository: "minion-hub",
            repositories: ["NikolasP98/minion_hub"],
            scopes: ["workforce"],
          },
        ]),
      }),
    ).toThrow("must include the configured intake project");
  });

  it("parses only fixed taxonomy route metadata", () => {
    const parsed = parseGithubStageTaskIntakeEnv({
      GITHUB_BUGS_STAGE_TASKS_PIPELINE_ID: pipelineId,
      GITHUB_BUGS_INTAKE_PROJECT_ID: intakeProjectId,
      GITHUB_BUGS_CLASSIFIER_AGENT_ID: classifierAgentId,
      GITHUB_BUGS_CLASSIFIER_MIN_CONFIDENCE: "0.8",
      GITHUB_BUGS_STAGE_TASK_ROUTES_JSON: JSON.stringify([
        {
          key: "portfolio-intake",
          name: "Portfolio Intake",
          projectId: intakeProjectId,
          repository: "cross-repo",
          repositories: ["*"],
          scopes: [],
        },
      ]),
    });

    expect(parsed).toMatchObject({
      config: {
        pipelineId,
        intakeProjectId,
        classifierAgentId,
        minimumConfidence: 0.8,
        routes: [{ key: "portfolio-intake", repository: "cross-repo", scopes: [] }],
      },
    });
  });
});
