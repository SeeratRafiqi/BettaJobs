import { DataTypes, Model } from 'sequelize';
import sequelize from '../config.js';
import { BaseModel } from '../base/BaseModel.js';

export interface UserAttributes {
  id: string;
  username: string;
  password: string | null;
  googleId: string | null;
  avatar: string | null;
  role: 'admin' | 'candidate' | 'company';
  email: string;
  name: string;
  email_verified?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export class User extends BaseModel<UserAttributes> implements UserAttributes {
  declare id: string;
  declare username: string;
  declare password: string | null;
  declare googleId: string | null;
  declare avatar: string | null;
  declare role: 'admin' | 'candidate' | 'company';
  declare email: string;
  declare name: string;
  declare email_verified: boolean;
  declare created_at: Date;
  declare updated_at: Date;
}

User.init(
  {
    id: {
      type: DataTypes.STRING(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    username: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    googleId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      unique: true,
    },
    avatar: {
      type: DataTypes.STRING(2048),
      allowNull: true,
    },
    role: {
      type: DataTypes.ENUM('admin', 'candidate', 'company'),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email_verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'users',
    timestamps: false,
    underscored: true,
  }
);
