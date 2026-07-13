export interface Script {
    onStart(): void;
    onLoop(): number;
    onStop(): void;
}
