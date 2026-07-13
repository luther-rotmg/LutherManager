/**
 * Float-precision world coordinates. For `Walking.walkTo(x, y)`, pass **x** then **y** as two
 * numbers — the same pair as this type’s fields.
 */
export class Position {
    constructor(
        public readonly x: number,
        public readonly y: number
    ) {}

    distanceTo(other: Position): number {
        return Math.sqrt(Math.pow(this.x - other.x, 2) + Math.pow(this.y - other.y, 2));
    }

    isWithin(other: Position, distance: number): boolean {
        return this.distanceTo(other) <= distance;
    }

    offset(dx: number, dy: number): Position {
        return new Position(this.x + dx, this.y + dy);
    }

    toString(): string {
        return `Position(${this.x.toFixed(2)}, ${this.y.toFixed(2)})`;
    }
}
