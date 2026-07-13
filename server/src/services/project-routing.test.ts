import { describe, expect, it } from "vitest";
import {
  classificationLabels,
  repositoryKeyFromFullName,
  resolveMinionClassifierProjectRoute,
  resolveProjectRoute,
  type RepositoryIssueClassification,
} from "./project-routing.js";

const classification: RepositoryIssueClassification = {
  workType: "bug",
  scopes: ["auth"],
  affectedRepositories: ["minion-hub"],
  affectedPaths: ["src/lib/auth/session.ts"],
  severity: "high",
  riskLabels: ["security"],
  confidence: 0.91,
  evidence: ["session initialization fails"],
  needsHuman: false,
};

describe("MINION Code project routing", () => {
  it("treats the signed webhook repository as authoritative and prefers the longest path rule", () => {
    const decision = resolveProjectRoute({
      signedRepositoryFullName: "NikolasP98/minion_hub",
      classification: { ...classification, affectedRepositories: ["minion-ai"] },
      intakeProjectId: "intake",
      rules: [
        { key: "hub-default", projectId: "hub", repository: "minion-hub" },
        {
          key: "hub-auth",
          projectId: "auth",
          repository: "minion-hub",
          scopes: ["auth"],
          pathPrefixes: ["src/lib/auth"],
        },
      ],
    });
    expect(decision).toMatchObject({ projectId: "auth", reason: "path", authoritativeRepository: "minion-hub" });
  });

  it("routes tied scope rules to Intake instead of choosing by list order", () => {
    const decision = resolveProjectRoute({
      signedRepositoryFullName: "NikolasP98/minion_hub",
      classification: { ...classification, affectedPaths: [] },
      intakeProjectId: "intake",
      rules: [
        { key: "auth-a", projectId: "a", repository: "minion-hub", scopes: ["auth"] },
        { key: "auth-b", projectId: "b", repository: "minion-hub", scopes: ["auth"] },
      ],
    });
    expect(decision).toMatchObject({ projectId: "intake", reason: "ambiguous", requiresHuman: true });
  });

  it("honors operator overrides before classifier confidence", () => {
    const decision = resolveProjectRoute({
      signedRepositoryFullName: "NikolasP98/minion_hub",
      classification: { ...classification, confidence: 0.1, needsHuman: true },
      operatorProjectId: "manual",
      intakeProjectId: "intake",
      rules: [],
    });
    expect(decision).toMatchObject({ projectId: "manual", reason: "operator_override", requiresHuman: false });
  });

  it("emits stable prefixed labels", () => {
    expect(repositoryKeyFromFullName("NikolasP98/minion_hub")).toBe("minion-hub");
    expect(classificationLabels("minion-hub", classification)).toEqual([
      "type:bug",
      "repo:minion-hub",
      "severity:high",
      "scope:auth",
      "risk:security",
    ]);
  });

  it("maps the fixed Minion classifier key only through a signed-repository route", () => {
    const decision = resolveMinionClassifierProjectRoute({
      signedRepositoryFullName: "NikolasP98/minion_hub",
      classification: {
        labels: ["bug"],
        scopes: ["workforce"],
        projectKey: "hub-workforce",
        confidence: 0.92,
        rationale: "The issue concerns the workforce projects surface.",
      },
      intakeProjectId: "intake",
      rules: [
        { key: "hub-workforce", projectId: "workforce", repository: "minion-hub", scopes: ["workforce"] },
        { key: "hub-workforce", projectId: "wrong-repo", repository: "minion-ai", scopes: ["workforce"] },
      ],
    });

    expect(decision).toMatchObject({
      projectId: "workforce",
      reason: "classifier_project",
      authoritativeRepository: "minion-hub",
      requiresHuman: false,
    });
  });

  it("sends low-confidence fixed classifier output to intake", () => {
    const decision = resolveMinionClassifierProjectRoute({
      signedRepositoryFullName: "NikolasP98/minion_hub",
      classification: {
        labels: ["bug"],
        scopes: ["workforce"],
        projectKey: "hub-workforce",
        confidence: 0.4,
        rationale: "Insufficient evidence.",
      },
      intakeProjectId: "intake",
      rules: [{ key: "hub-workforce", projectId: "workforce", repository: "minion-hub", scopes: ["workforce"] }],
    });

    expect(decision).toMatchObject({ projectId: "intake", reason: "low_confidence", requiresHuman: true });
  });
});
