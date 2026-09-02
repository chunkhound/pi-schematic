import type { ConstraintRegistry } from "./registry.js";
import type { AnyConstraintDescriptor, ConstraintDiagnostic, ConstraintEditorSpec, ConstraintEvaluation, ConstraintViolation, ErasedConstraintEvaluation } from "./types.js";

export interface ConstraintDiagnosticRecord extends ConstraintDiagnostic {
	text: string;
}

export type ConstraintEditorRow =
	| { kind: "automatic"; label: string }
	| { kind: "toggle"; label: string; value: string; active: boolean }
	| { kind: "choice"; label: string; value: readonly string[] }
	| { kind: "number"; label: string; value: number | null; unit: string; min: number; step: number };

export function presentConstraintGroups(evaluations: readonly ErasedConstraintEvaluation[], registry: ConstraintRegistry): string[] {
	return evaluations.flatMap((evaluation) => {
		const descriptor = registry.get(evaluation.key);
		return descriptor ? [descriptor.present.group(evaluation)] : [];
	});
}

export function presentConstraintPrompt(evaluations: readonly ErasedConstraintEvaluation[], registry: ConstraintRegistry): string[] {
	return evaluations.flatMap((evaluation) => {
		const descriptor = registry.get(evaluation.key);
		return descriptor ? [descriptor.present.prompt(evaluation)] : [];
	});
}

export function presentConstraintDiagnosticRecords(evaluations: readonly ErasedConstraintEvaluation[], registry: ConstraintRegistry): ConstraintDiagnosticRecord[] {
	return evaluations.flatMap((evaluation) => evaluation.diagnostics.flatMap((diagnostic) => {
		const descriptor = registry.get(diagnostic.key);
		return descriptor ? [{ ...diagnostic, text: descriptor.present.diagnostic(diagnostic) }] : [];
	}));
}

export function presentConstraintDiagnostics(diagnostics: readonly ConstraintDiagnostic[], registry: ConstraintRegistry): string[] {
	return diagnostics.flatMap((diagnostic) => {
		const descriptor = registry.get(diagnostic.key);
		return descriptor ? [descriptor.present.diagnostic(diagnostic)] : [];
	});
}

export function constraintEditorRows(
	descriptor: AnyConstraintDescriptor,
	evaluation: ErasedConstraintEvaluation,
	override?: unknown,
): readonly ConstraintEditorRow[] {
	const editor = descriptor.editor as ConstraintEditorSpec<unknown, unknown>;
	if (editor.kind === "multi-select") {
		const choices = editor.choices(evaluation as ConstraintEvaluation<unknown, unknown>);
		const effective = (evaluation as ConstraintEvaluation<unknown, unknown>).effective as readonly string[] | undefined;
		const rows: ConstraintEditorRow[] = [{ kind: "automatic", label: editor.automatic(evaluation as ConstraintEvaluation<unknown, unknown>) }];
		for (const choice of choices) {
			rows.push({ kind: "toggle", label: choice, value: choice, active: effective?.includes(choice) ?? false });
		}
		return rows;
	}
	return [
		{ kind: "automatic", label: editor.automatic(evaluation as ConstraintEvaluation<unknown, unknown>) },
		{ kind: "number", label: editor.label, value: editor.value(evaluation as ConstraintEvaluation<unknown, unknown>), unit: editor.unit, min: editor.min, step: editor.step },
	];
}

export function presentConstraintViolation(violation: ConstraintViolation, registry: ConstraintRegistry): string | undefined {
	return registry.get(violation.key)?.present.violation(violation);
}
