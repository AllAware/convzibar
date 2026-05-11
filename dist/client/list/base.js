export class BaseListBuilder {
    z;
    _objectType;
    _objectId;
    _subjectType;
    _subjectId;
    _relation;
    _permission;
    _mapFn;
    constructor(z) {
        this.z = z;
    }
    object(objectOrType) {
        if (typeof objectOrType === "string") {
            this._objectType = objectOrType;
            this._objectId = undefined;
        }
        else {
            this._objectType = objectOrType.type;
            this._objectId = objectOrType.id;
        }
        return this;
    }
    subject(subjectOrType) {
        if (typeof subjectOrType === "string") {
            this._subjectType = subjectOrType;
            this._subjectId = undefined;
        }
        else {
            this._subjectType = subjectOrType.type;
            this._subjectId = subjectOrType.id;
        }
        return this;
    }
    relation(relation) {
        this._relation = relation;
        return this;
    }
    permission(permission) {
        this._permission = permission;
        return this;
    }
    map(fn) {
        this._mapFn = fn;
        return this;
    }
    async _applyMap(items) {
        if (!this._mapFn)
            return items;
        return Promise.all(items.map(this._mapFn));
    }
}
//# sourceMappingURL=base.js.map