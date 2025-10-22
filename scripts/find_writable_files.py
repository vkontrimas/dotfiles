import os
import stat
from pathlib import Path
from tqdm import tqdm
import argparse


def get_all_files(directory):
    """Recursively get all files in the directory."""
    print(f"Scanning directory: {directory}")
    all_files = []
    
    for root, dirs, files in os.walk(directory):
        for file in files:
            all_files.append(os.path.join(root, file))
    
    print(f"Found {len(all_files)} files total")
    return all_files


def is_writable(filepath):
    """Check if a file is writable."""
    try:
        # Check if file has write permissions
        return os.access(filepath, os.W_OK)
    except Exception:
        return False


def make_readonly(filepath):
    """Make a file readonly by removing write permissions."""
    try:
        # Get current permissions
        current_permissions = os.stat(filepath).st_mode
        # Remove write permissions for owner, group, and others
        readonly_permissions = current_permissions & ~stat.S_IWUSR & ~stat.S_IWGRP & ~stat.S_IWOTH
        # Set the new permissions
        os.chmod(filepath, readonly_permissions)
        return True
    except Exception as e:
        return False


def find_writable_files(directory):
    """Find all writable files in a directory."""
    # First, get all files
    all_files = get_all_files(directory)
    
    # Then check permissions with progress bar
    writable_files = []
    
    print("\nChecking write permissions...")
    for filepath in tqdm(all_files, desc="Checking files", unit="file"):
        if is_writable(filepath):
            writable_files.append(filepath)
    
    return writable_files


def main():
    parser = argparse.ArgumentParser(description="Find all writable files in a directory recursively")
    parser.add_argument("directory", help="Directory path to scan")
    parser.add_argument("-o", "--output", help="Output file to save results (optional)")
    parser.add_argument("-r", "--readonly", action="store_true", 
                        help="Make all writable files readonly")
    
    args = parser.parse_args()
    
    directory = args.directory
    
    if not os.path.exists(directory):
        print(f"Error: Directory '{directory}' does not exist")
        return
    
    if not os.path.isdir(directory):
        print(f"Error: '{directory}' is not a directory")
        return
    
    # Find writable files
    writable_files = find_writable_files(directory)
    
    # Display results
    print(f"\n{'='*60}")
    print(f"Found {len(writable_files)} writable files")
    print(f"{'='*60}\n")
    
    if writable_files:
        for file in writable_files[:10]:  # Show first 10
            print(file)
        
        if len(writable_files) > 10:
            print(f"\n... and {len(writable_files) - 10} more files")
    
    # Make files readonly if requested
    if args.readonly and writable_files:
        print(f"\n{'='*60}")
        response = input(f"Are you sure you want to make {len(writable_files)} files readonly? (yes/no): ")
        
        if response.lower() in ['yes', 'y']:
            print("\nMaking files readonly...")
            successful = 0
            failed = 0
            
            for filepath in tqdm(writable_files, desc="Setting readonly", unit="file"):
                if make_readonly(filepath):
                    successful += 1
                else:
                    failed += 1
            
            print(f"\nSuccessfully set {successful} files to readonly")
            if failed > 0:
                print(f"Failed to modify {failed} files")
        else:
            print("Operation cancelled")
    
    # Save to file if requested
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            for file in writable_files:
                f.write(f"{file}\n")
        print(f"\nResults saved to: {args.output}")


if __name__ == "__main__":
    main()
