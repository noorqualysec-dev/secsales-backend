import type { Response } from "express";
import bcrypt from "bcrypt";
import { Types } from "mongoose";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { User } from "../models/mongoModels.js";
import generateToken from "../utils/generateToken.js";

export const signInUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = req.body.password;
    if (!email || typeof password !== "string" || !password) {
      res.status(400).json({ success: false, message: "Please provide email and password" });
      return;
    }

    const user = await User.findOne({ email, isActive: true }).select("+passwordHash");
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ success: false, message: "Invalid credentials" });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        token: generateToken(user._id.toString()),
      },
    });
  } catch (error) {
    console.error("Sign-in failed:", error);
    res.status(500).json({ success: false, message: "Sign-in failed" });
  }
};

export const deleteUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id ?? "");
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid user ID" });
      return;
    }
    if (req.user?.role !== "admin") {
      res.status(403).json({ success: false, message: "Only an admin can deactivate users" });
      return;
    }
    if (id === req.user.id) {
      res.status(400).json({ success: false, message: "You cannot deactivate your own account" });
      return;
    }

    const user = await User.findByIdAndUpdate(
      id,
      { $set: { isActive: false, deactivatedAt: new Date() } },
      { new: true, runValidators: true },
    ).select("_id isActive");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.status(200).json({ success: true, message: "User deactivated successfully" });
  } catch (error) {
    console.error("User deactivation failed:", error);
    res.status(500).json({ success: false, message: "User deactivation failed" });
  }
};

export const updateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id ?? "");
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid user ID" });
      return;
    }
    if (id !== req.user?.id) {
      res.status(403).json({ success: false, message: "You may only update your own profile" });
      return;
    }

    const updates: { name?: string; email?: string; passwordHash?: string } = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        res.status(400).json({ success: false, message: "Name cannot be empty" });
        return;
      }
      updates.name = name;
    }
    if (req.body.email !== undefined) {
      const email = String(req.body.email).trim().toLowerCase();
      if (!email) {
        res.status(400).json({ success: false, message: "Email cannot be empty" });
        return;
      }
      updates.email = email;
    }
    if (req.body.password !== undefined) {
      if (typeof req.body.password !== "string" || req.body.password.length < 6) {
        res.status(400).json({ success: false, message: "Password must be at least 12 characters" });
        return;
      }
      updates.passwordHash = await bcrypt.hash(req.body.password, 12);
    }
    if (req.body.role !== undefined || req.body.isActive !== undefined) {
      res.status(403).json({ success: false, message: "Role and activation changes require admin user management" });
      return;
    }

    const user = await User.findByIdAndUpdate(id, { $set: updates }, {
      new: true,
      runValidators: true,
    }).select("_id name email role isActive");
    if (!user) {
      res.status(404).json({ success: false, message: "User not found" });
      return;
    }
    res.status(200).json({ success: true, message: "User updated successfully", data: user });
  } catch (error) {
    console.error("Profile update failed:", error);
    res.status(500).json({ success: false, message: "Profile update failed" });
  }
};
